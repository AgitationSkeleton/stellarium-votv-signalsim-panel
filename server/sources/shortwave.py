"""Shortwave / numbers-station listening guide.

Data sources (all public, polled politely, cached):
* Priyom transmission schedule - https://calendar2.priyom.org/events (the JSON
  feed behind priyom.org/number-stations/station-schedule). Fetched in the same
  fixed 12-hour-aligned 24 h slices Priyom's own widget requests, every 30 min.
  Content (c) Priyom.org, CC BY-NC-SA 4.0 - attributed in the UI.
* KiwiSDR public receiver list - http://rx.linkfanel.net/kiwisdr_com.js
  (generated from kiwisdr.com/public), hourly.
* WebSDR (University of Twente) and Priyom's "Pavlova" KiwiSDR dispatcher:
  a light reachability check every 15 minutes.

Tuning never proxies or records anyone's receiver: the panel only builds the
receivers' own deep links (WebSDR ?tune=, KiwiSDR ?f=) to open in a new tab.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

from ..net import client_session

LOG = logging.getLogger("panel.shortwave")
USER_AGENT = "stellarium-votv-signalsim-panel/1.0 (self-hosted LAN console)"
PRIYOM_EVENTS = "https://calendar2.priyom.org/events"
KIWI_LIST = "http://rx.linkfanel.net/kiwisdr_com.js"

# Same receiver set and tuning conventions as Priyom's own schedule widget
# (priyom.org /scripts/nextevents-20201105.js, GPLv3+).
WEBSDRS = [
    {"id": "utwente", "name": "WebSDR · University of Twente (NL)", "url": "http://websdr.ewi.utwente.nl:8901/",
     "tune": "http://websdr.ewi.utwente.nl:8901/?tune={freq}{mode}", "target": None, "min": 0, "max": 29160, "fixCW": False},
    {"id": "printf", "name": "WebSDR · argonn (PL)", "url": "http://websdr.printf.cc:8901/",
     "tune": "http://websdr.printf.cc:8901/?tune={freq}{mode}", "target": "Eastern Europe", "min": 0, "max": 8048, "fixCW": True},
]
PAVLOVA = {"North America": "n", "Pacific": "p", "East Asia": "a", "Middle East": "m"}
PAVLOVA_URL = "http://s.printf.cc/"
REGION_CENTRES = {  # rough centroids used to pick nearby KiwiSDRs for a transmission's target area
    "North America": (40.0, -95.0), "East Asia": (35.0, 125.0), "Middle East": (30.0, 45.0),
    "Eastern Europe": (52.0, 30.0), "Pacific": (21.0, -157.0), "Europe": (50.0, 10.0),
}
# Always-on Russian military markers. Frequencies and modes as listed on the
# station pages at priyom.org/military-stations/russia/ (checked 2026-11).
CONTINUOUS = [
    {"station": "S28", "name": "UVB-76 \"The Buzzer\"", "freqs": [{"khz": 4625, "label": "24 H"}], "mode": "USB",
     "target": "Eastern Europe", "note": "Continuous buzzer channel marker with occasional live voice messages.",
     "source": "https://priyom.org/military-stations/russia/the-buzzer"},
    {"station": "S30", "name": "\"The Pip\"", "freqs": [{"khz": 5448, "label": "DAYTIME"}, {"khz": 3756, "label": "NIGHTTIME"}],
     "mode": "USB", "target": "Eastern Europe",
     "note": "Continuous pip channel marker; day/night switch-over varies by season.",
     "source": "https://priyom.org/military-stations/russia/the-pip"},
    {"station": "S32", "name": "\"The Squeaky Wheel\"", "freqs": [{"khz": 5367, "label": "DAYTIME"}, {"khz": 3363.5, "label": "NIGHTTIME"}],
     "mode": "USB", "target": "Eastern Europe",
     "note": "Continuous squeaky-wheel marker; day/night switch-over varies by season.",
     "source": "https://priyom.org/military-stations/russia/the-squeaky-wheel"},
]
# Priyom's parser for event summaries, e.g. "V13 15388kHz USB/AM [Target: East Asia]" or "F06a Search".
SUMMARY = re.compile(r"^([\w /-]+?) (?:(Search)|(\d+(?:\.\d+)?) ?[kK][hH][zZ](?:(?:.*?[kK][hH][zZ])?? ([A-Z][A-Z/]+))?)(?:.*?\[Target: ([\w -]+)\])?")
FAMILY = {"E": "English voice", "G": "German voice", "S": "Slavic-language voice", "V": "Other-language voice",
          "M": "Morse", "F": "Digital / data mode", "X": "Oddity / unclassified", "H": "Hybrid voice + data"}


def family_of(station: str) -> str | None:
    letter = (station or "").strip()[:1].upper()
    return FAMILY.get(letter)


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(min(1.0, math.sqrt(h)))


class ShortwaveSource:
    def __init__(self, config: dict):
        self.config = config
        self.events: list[dict] = []
        self.priyom = {"available": False, "error": None, "fetched": None, "slices": {}}
        self.kiwis: list[dict] = []
        self.kiwi_status = {"available": False, "error": None, "fetched": None, "data_timestamp": None}
        self.provider_status: dict[str, dict] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.config.get("shortwave_enabled", True))

    # -- pollers -------------------------------------------------------------
    async def run_forever(self) -> None:
        await asyncio.sleep(15)
        last = {"priyom": 0.0, "kiwi": 0.0, "status": 0.0}
        timeout = aiohttp.ClientTimeout(total=30, connect=10)
        async with client_session(timeout) as session:
            while True:
                if self.enabled:
                    now = time.time()
                    if now - last["priyom"] > 1800:
                        last["priyom"] = now
                        await self._fetch_priyom(session)
                    if now - last["kiwi"] > 3600:
                        last["kiwi"] = now
                        await self._fetch_kiwis(session)
                    if now - last["status"] > 900:
                        last["status"] = now
                        await self._check_providers(session)
                await asyncio.sleep(30)

    async def _fetch_priyom(self, session: aiohttp.ClientSession) -> None:
        now = datetime.now(timezone.utc)
        start = now.replace(hour=0 if now.hour < 12 else 12, minute=0, second=0, microsecond=0)
        slices = [start, start + timedelta(hours=12)]   # current and next half-day aligned 24 h windows
        events: dict[tuple, dict] = {}
        try:
            for slice_start in slices:
                key = slice_start.isoformat()
                params = {"timeMin": slice_start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                          "timeMax": (slice_start + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
                async with session.get(PRIYOM_EVENTS, params=params) as response:
                    response.raise_for_status()
                    payload = await response.json(content_type=None)
                for item in payload.get("items", []):
                    parsed = self._parse_event(item)
                    if parsed:
                        events[(parsed["start"], parsed["summary"])] = parsed
                self.priyom["slices"][key] = len(payload.get("items", []))
            self.events = sorted(events.values(), key=lambda e: e["start"])
            self.priyom.update(available=True, error=None, fetched=now.isoformat())
            LOG.info("Priyom schedule: %s transmissions in the next 36 h", len(self.events))
        except Exception as error:
            self.priyom.update(available=bool(self.events), error=str(error) or error.__class__.__name__)
            LOG.warning("Priyom schedule fetch failed: %s", error)

    @staticmethod
    def _parse_event(item: dict) -> dict | None:
        summary = str(item.get("summary") or "").strip()
        start = (item.get("start") or {}).get("dateTime")
        if not summary or not start:
            return None
        match = SUMMARY.match(summary)
        station = match.group(1).strip() if match else summary.split(" ", 1)[0]
        freq = float(match.group(3)) if match and match.group(3) else None
        return {"summary": summary, "start": start, "station": station, "family": family_of(station),
                "freq_khz": freq, "mode": (match.group(4) if match else None), "target": (match.group(5) if match else None),
                "search": bool(match and match.group(2))}

    async def _fetch_kiwis(self, session: aiohttp.ClientSession) -> None:
        try:
            async with session.get(KIWI_LIST) as response:
                response.raise_for_status()
                text = await response.text()
            stamp = re.search(r"KiwiSDR\.com data timestamp:\s*(.+)", text)
            body = text[text.index("["): text.rindex("]") + 1]
            body = re.sub(r",\s*([\]}])", r"\1", body)          # tolerate JS trailing commas
            rows = json.loads(body)
            kiwis = []
            for row in rows:
                gps = re.findall(r"-?\d+(?:\.\d+)?", row.get("gps", ""))
                bands = re.findall(r"\d+", row.get("bands", "0-30000000"))
                kiwis.append({
                    "name": row.get("name", "")[:120], "url": row.get("url", "").rstrip("/"),
                    "loc": row.get("loc", "")[:80], "antenna": row.get("antenna", "")[:80],
                    "online": row.get("status") == "active" and row.get("offline") == "no",
                    "users": int(row.get("users") or 0), "users_max": int(row.get("users_max") or 0),
                    "lat": float(gps[0]) if len(gps) >= 2 else None, "lon": float(gps[1]) if len(gps) >= 2 else None,
                    "min_khz": int(bands[0]) / 1000 if len(bands) >= 2 else 0,
                    "max_khz": int(bands[1]) / 1000 if len(bands) >= 2 else 30000,
                    "snr": row.get("snr", ""), "updated": row.get("updated"),
                })
            self.kiwis = [k for k in kiwis if k["url"].startswith(("http://", "https://"))]
            self.kiwi_status.update(available=True, error=None, fetched=datetime.now(timezone.utc).isoformat(),
                                    data_timestamp=stamp.group(1).strip() if stamp else None)
            LOG.info("KiwiSDR list: %s receivers", len(self.kiwis))
        except Exception as error:
            self.kiwi_status.update(available=bool(self.kiwis), error=str(error) or error.__class__.__name__)
            LOG.warning("KiwiSDR list fetch failed: %s", error)

    async def _check_providers(self, session: aiohttp.ClientSession) -> None:
        targets = [(w["id"], w["url"]) for w in WEBSDRS] + [("pavlova", PAVLOVA_URL)]
        for pid, url in targets:
            started = time.monotonic()
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=12, connect=8)) as response:
                    await response.content.read(512)
                    online, detail = response.status < 500, f"HTTP {response.status}"
            except Exception as error:
                online, detail = False, error.__class__.__name__
            self.provider_status[pid] = {"online": online, "detail": detail, "checked": datetime.now(timezone.utc).isoformat(),
                                         "latency_ms": round((time.monotonic() - started) * 1000)}

    # -- tuning --------------------------------------------------------------
    @staticmethod
    def _mode_and_freq(freq: float, mode: str | None, fix_cw: bool = False) -> tuple[float, str]:
        mode = (mode or "USB").upper()
        if mode in ("RTTY", "RTTY/CW"):
            return freq - 2, "usb"                 # Priyom: listen as USB centred 2 kHz below
        if mode == "CW":
            return (freq - 0.75 if fix_cw else freq), "cw"
        if mode in ("LSB", "AM"):
            return freq, mode.lower()
        return freq, "usb"                         # USB, USB/AM and anything else

    def tune(self, freq: float, mode: str | None, target: str | None) -> list[dict]:
        links = []
        for websdr in WEBSDRS:
            if websdr["min"] <= freq <= websdr["max"] and (websdr["target"] is None or websdr["target"] == target):
                f, m = self._mode_and_freq(freq, mode, websdr["fixCW"])
                status = self.provider_status.get(websdr["id"], {})
                links.append({"provider": websdr["name"], "kind": "websdr", "url": websdr["tune"].format(freq=f"{f:g}", mode=m),
                              "online": status.get("online"), "detail": status.get("detail")})
        if target in PAVLOVA:
            f, m = self._mode_and_freq(freq, mode)
            status = self.provider_status.get("pavlova", {})
            links.append({"provider": f"Priyom Pavlova KiwiSDR dispatcher · {target}", "kind": "dispatcher",
                          "url": f"{PAVLOVA_URL}#{PAVLOVA[target]}/{f:g}{m}", "online": status.get("online"), "detail": status.get("detail")})
        centre = REGION_CENTRES.get(target or "Europe", REGION_CENTRES["Europe"])
        candidates = [k for k in self.kiwis if k["online"] and k["users"] < k["users_max"] and k["lat"] is not None
                      and k["min_khz"] <= freq <= k["max_khz"]]
        candidates.sort(key=lambda k: haversine_km(centre, (k["lat"], k["lon"])))
        for kiwi in candidates[:int(self.config.get("shortwave_kiwi_suggestions", 4))]:
            f, m = self._mode_and_freq(freq, mode)
            links.append({"provider": f"KiwiSDR · {kiwi['name']}", "kind": "kiwisdr", "url": f"{kiwi['url']}/?f={f:g}{m}z10",
                          "online": True, "detail": f"{kiwi['users']}/{kiwi['users_max']} listeners · {kiwi['loc']}",
                          "distance_km": round(haversine_km(centre, (kiwi["lat"], kiwi["lon"])))})
        return links

    # -- views ------------------------------------------------------------------
    def overview(self, hours: float = 12) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        on_air_minutes = float(self.config.get("shortwave_on_air_minutes", 15))
        window_start = now - timedelta(minutes=on_air_minutes)
        horizon = now + timedelta(hours=hours)
        events = []
        for event in self.events:
            start = datetime.fromisoformat(event["start"].replace("Z", "+00:00"))
            if window_start <= start <= horizon:
                minutes = (start - now).total_seconds() / 60
                events.append({**event, "minutes_until": round(minutes, 1),
                               "status": "on-air" if minutes <= 0 else "soon" if minutes <= 30 else "scheduled"})
        online_kiwis = [k for k in self.kiwis if k["online"]]
        return {
            "now": now.isoformat(), "events": events, "on_air_minutes": on_air_minutes,
            "continuous": CONTINUOUS,
            "providers": {
                "priyom": {"name": "Priyom transmission schedule", **{k: v for k, v in self.priyom.items() if k != "slices"}},
                "kiwisdr": {"name": "KiwiSDR public network", **self.kiwi_status, "total": len(self.kiwis),
                            "online": len(online_kiwis), "free": sum(1 for k in online_kiwis if k["users"] < k["users_max"])},
                **{w["id"]: {"name": w["name"], **self.provider_status.get(w["id"], {})} for w in WEBSDRS},
                "pavlova": {"name": "Priyom Pavlova KiwiSDR dispatcher", **self.provider_status.get("pavlova", {})},
            },
            "families": FAMILY,
        }
