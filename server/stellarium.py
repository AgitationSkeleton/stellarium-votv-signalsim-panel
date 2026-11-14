"""Stellarium Remote Control client.

Designed to sit politely beside anything else that uses Stellarium:
* All browser clients share ONE server-side poller (status + view every few
  seconds), so the panel adds a constant, small load no matter how many
  screens are open.
* Catalogue enrichment is strictly serial with a gap between requests, and
  pauses whenever Stellarium is slow or offline.
* View control is opt-in (PIN) and temporary: the original view is saved on the
  first command and restored automatically after a few idle minutes.
* Optionally (log_selections), every object you select in Stellarium is logged
  as a sighting, which drives the panel's database, statistics and ticker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

from . import astro
from .db import PanelDB, utc_now
from .taxonomy import category_from_stellarium

LOG = logging.getLogger("panel.stellarium")

INFO_KEEP = (
    "name", "localized-name", "object-type", "type", "designations", "iauConstellation", "vmag", "vmage",
    "bmag", "bV", "raJ2000", "decJ2000", "distance", "distance-km", "distance-ly", "parent", "size-deg",
    "axis-major-deg", "axis-minor-deg", "morpho-type", "surface-brightness", "redshift", "spectral-class",
    "variable-star", "period", "absolute-mag", "illumination", "phase", "rise", "set", "transit",
    "population-index", "velocity", "zhr", "activity", "peak", "parallax", "albedo", "heliocentric-distance",
    "elongation-deg", "star-type", "discoverer", "discovered",
)


class StellariumService:
    def __init__(self, config: dict, db: PanelDB):
        self.config = config
        self.db = db
        self.base = config["stellarium_url"].rstrip("/")
        self.session: aiohttp.ClientSession | None = None
        self._request_lock = asyncio.Semaphore(2)
        self.online = False
        self.last_ok: float | None = None
        self.last_error: str | None = None
        self.status: dict[str, Any] = {}
        self.view: dict[str, Any] = {}
        self._prev_view: tuple[float, float, float] | None = None
        self.speed = {"az": 0.0, "alt": 0.0}
        fallback = config["observer_fallback"]
        self.location = {"name": fallback["name"], "latitude": fallback["latitude"],
                         "longitude": fallback["longitude"], "altitude_m": fallback["altitude_m"]}
        self.solar: dict[str, dict] = {}
        self._info_cache: dict[str, tuple[float, dict]] = {}
        # control
        self.control_saved: dict[str, Any] | None = None
        self.control_last: float = 0.0
        self.control_target: str | None = None
        self.enrich_progress = {"pending": 0, "done": 0}
        self._last_selection = ""
        self.latest_selection: dict | None = None

    # -- plumbing ------------------------------------------------------------
    async def start(self) -> None:
        password = str(self.config.get("stellarium_password") or "")
        auth = aiohttp.BasicAuth("", password) if password else None   # Remote Control plugin password
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8, connect=3), auth=auth)

    async def close(self) -> None:
        if self.session:
            await self.session.close()

    async def _get(self, path: str, params: dict | None = None) -> Any:
        assert self.session
        async with self._request_lock:
            async with self.session.get(self.base + path, params=params) as response:
                if response.status == 404:
                    return None
                response.raise_for_status()
                text = await response.text()
        try:
            return json.loads(text)
        except ValueError:
            return text

    async def _post(self, path: str, data: dict) -> str:
        assert self.session
        async with self._request_lock:
            async with self.session.post(self.base + path, data=data) as response:
                response.raise_for_status()
                return (await response.text()).strip()

    # -- live poller ---------------------------------------------------------
    async def poll_forever(self) -> None:
        interval = float(self.config.get("stellarium_poll_seconds", 3))
        while True:
            try:
                status = await self._get("/api/main/status")
                view = await self._get("/api/main/view")
                self._absorb(status or {}, view or {})
                self.online = True
                await self._log_selection()
                self.last_ok = time.time()
                self.last_error = None
            except Exception as error:  # Stellarium closed, restarting, or busy
                if self.online:
                    LOG.warning("Stellarium went offline: %s", error)
                self.online = False
                self.last_error = str(error) or error.__class__.__name__
            await asyncio.sleep(interval if self.online else max(interval, 10))

    def _absorb(self, status: dict, view: dict) -> None:
        self.status = status
        location = status.get("location") or {}
        if "latitude" in location:
            self.location = {"name": location.get("name") or self.location["name"],
                             "latitude": float(location["latitude"]), "longitude": float(location["longitude"]),
                             "altitude_m": float(location.get("altitude", 0))}
        altaz = astro.parse_vector(view.get("altAz"))
        j2000 = astro.parse_vector(view.get("j2000"))
        now = time.time()
        result: dict[str, Any] = {"fov": float((status.get("view") or {}).get("fov") or 0)}
        if altaz:
            az, alt = astro.stel_altaz_vector_to_azalt(altaz)
            result.update(az=az, alt=alt, altaz_vec=list(altaz))
            if self._prev_view:
                last_t, last_az, last_alt = self._prev_view
                dt = max(0.5, now - last_t)
                self.speed = {"az": abs(astro.azimuth_delta(last_az, az)) / dt, "alt": abs(alt - last_alt) / dt}
            self._prev_view = (now, az, alt)
        if j2000:
            ra, dec = astro.j2000_vector_to_radec(j2000)
            result.update(ra=ra, dec=dec, j2000=list(j2000))
        self.view = result

    def snapshot(self) -> dict[str, Any]:
        time_info = self.status.get("time") or {}
        return {
            "online": self.online,
            "last_ok_age": None if self.last_ok is None else round(time.time() - self.last_ok, 1),
            "error": self.last_error if not self.online else None,
            "location": self.location,
            "view": self.view,
            "speed": self.speed,
            "selection": _strip_html(self.status.get("selectioninfo") or "")[:200],
            "time": {"utc": time_info.get("utc"), "local": time_info.get("local"),
                     "timezone": time_info.get("timeZone"), "is_now": time_info.get("isTimeNow"),
                     "rate": time_info.get("timerate")},
            "control": self.control_snapshot(),
            "enrichment": self.enrich_progress,
        }

    # -- selection log ---------------------------------------------------------
    async def _log_selection(self) -> None:
        """Log a sighting when the Stellarium selection changes to a new object."""
        if not self.config.get("log_selections", True):
            return
        text = _strip_html(self.status.get("selectioninfo") or "")
        if text == self._last_selection:
            return
        self._last_selection = text
        if not text:
            return
        try:
            payload = await self._get("/api/objects/info", {"format": "json"})   # no name = current selection
        except Exception as error:
            LOG.debug("selection info failed: %s", error)
            return
        if not isinstance(payload, dict) or payload.get("found") is False or not payload.get("name"):
            return
        result = await asyncio.to_thread(self._store_selection, payload)
        if result:
            self.latest_selection = result

    def _store_selection(self, payload: dict) -> dict | None:
        name = str(payload.get("localized-name") or payload.get("name"))
        object_type = payload.get("object-type") or payload.get("type")
        category = category_from_stellarium(object_type, "star" if "star" in str(object_type).lower() else "other")
        if name in ("Sun", "Moon") or str(object_type).lower() in ("planet", "moon"):
            category = "moon" if name == "Moon" or str(object_type).lower() == "moon" else "planet"
        vmag = _num(payload.get("vmag", payload.get("vmage")))
        if vmag is not None and vmag >= 50:
            vmag = None
        now = utc_now()
        info = {key: payload[key] for key in INFO_KEEP if key in payload}
        with self.db.transaction() as conn:
            pid = PanelDB.upsert_phenomenon(conn, key=astro.normalize_name(name), name=name, category=category,
                                            source="stellarium", catalog="Selected in Stellarium",
                                            ra=_num(payload.get("raJ2000")), dec=_num(payload.get("decJ2000")),
                                            vmag=vmag, constellation=payload.get("iauConstellation"), info=info)
            # one sighting per object per 10 minutes, however often it is re-selected
            since = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
            if PanelDB.seen_since(conn, pid, since, "stellarium"):
                return None
            detail = {"az": payload.get("azimuth"), "alt": payload.get("altitude"), "vmag": vmag}
            PanelDB.add_sighting(conn, pid, now, "stellarium", f"{pid}@{now}", detail)
        return {"id": pid, "name": name, "category": category, "observed_utc": now}

    # -- object info -----------------------------------------------------------
    async def info(self, name: str, max_age: float = 15.0) -> dict | None:
        cached = self._info_cache.get(name)
        if cached and time.time() - cached[0] < max_age:
            return cached[1]
        if not self.online:
            return cached[1] if cached else None
        try:
            payload = await self._get("/api/objects/info", {"name": name, "format": "json"})
        except Exception as error:
            LOG.debug("info %s failed: %s", name, error)
            return cached[1] if cached else None
        if not isinstance(payload, dict) or not payload.get("found", True):
            return None
        self._info_cache[name] = (time.time(), payload)
        if len(self._info_cache) > 500:
            for key in sorted(self._info_cache, key=lambda k: self._info_cache[k][0])[:100]:
                self._info_cache.pop(key, None)
        return payload

    async def find(self, text: str) -> list[str]:
        if not self.online or not text.strip():
            return []
        result = await self._get("/api/objects/find", {"str": text.strip()[:60]})
        return [str(item) for item in result][:30] if isinstance(result, list) else []

    # -- solar system ----------------------------------------------------------
    async def solar_forever(self) -> None:
        while True:
            if self.online:
                for name in self.config.get("solar_system_live", []):
                    info = await self.info(name, max_age=50)
                    if info:
                        self.solar[name] = {
                            "name": name, "az": info.get("azimuth"), "alt": info.get("altitude"),
                            "vmag": info.get("vmag"), "distance_au": info.get("distance"),
                            "illumination": info.get("illumination"), "constellation": info.get("iauConstellation"),
                            "rise": info.get("rise"), "set": info.get("set"), "transit": info.get("transit"),
                            "ra": info.get("raJ2000"), "dec": info.get("decJ2000"),
                        }
                    await asyncio.sleep(float(self.config.get("stellarium_request_gap_seconds", 0.6)))
            await asyncio.sleep(60)

    # -- catalogue seeding / enrichment ------------------------------------
    async def catalog_forever(self) -> None:
        await asyncio.sleep(20)
        while True:
            try:
                if self.online:
                    await self._seed_catalog()
                    await self._enrich_pending()
            except Exception:
                LOG.exception("catalog maintenance failed")
            await asyncio.sleep(600)

    # NOTE: every database call below goes through asyncio.to_thread. The DB
    # lock can be held for a while by an ingest thread, and blocking the event
    # loop on it would freeze the whole web server.
    async def _seed_catalog(self) -> None:
        last = await asyncio.to_thread(self.db.kv_get, "stellarium_seed_utc")
        if last and datetime.now(timezone.utc) - datetime.fromisoformat(last) < timedelta(days=7):
            return
        total = 0
        for entry in self.config.get("stellarium_catalog_types", []):
            try:
                names = await self._get("/api/objects/listobjectsbytype", {"type": entry["type"], "english": 1})
            except Exception as error:
                LOG.warning("list %s failed: %s", entry["type"], error)
                continue
            if not isinstance(names, list):
                continue
            names = [str(name) for name in names if str(name).strip() and str(name) != "Earth"]
            names = sorted(set(names))[: int(entry.get("max", 500))]
            await asyncio.to_thread(self._store_names, entry, names)
            total += len(names)
            await asyncio.sleep(1)
        # Sun and Moon are not listed by any of the type queries above.
        await asyncio.to_thread(self._store_names, {"category": "planet", "label": "Solar System"}, ["Sun"])
        await asyncio.to_thread(self._store_names, {"category": "moon", "label": "Solar System"}, ["Moon"])
        await asyncio.to_thread(self.db.kv_set, "stellarium_seed_utc", utc_now())
        LOG.info("Seeded %s catalogue names from Stellarium", total)

    def _store_names(self, entry: dict, names: list[str]) -> None:
        with self.db.transaction() as conn:
            for name in names:
                PanelDB.upsert_phenomenon(conn, key=astro.normalize_name(name), name=name,
                                          category=entry["category"], source="stellarium", catalog=entry["label"])

    def _refresh_cutoffs(self) -> dict[str, str]:
        now = datetime.now(timezone.utc)
        return {entry["label"]: (now - timedelta(days=float(entry["refresh_days"]))).isoformat()
                for entry in self.config.get("stellarium_catalog_types", []) if entry.get("refresh_days")}

    async def _enrich_pending(self) -> None:
        gap = float(self.config.get("stellarium_request_gap_seconds", 0.6))
        cutoffs = self._refresh_cutoffs()
        rows = await asyncio.to_thread(
            self.db.query, "SELECT id, name, category, catalog, enriched_utc FROM phenomena "
                           "WHERE source = 'stellarium' ORDER BY enriched_utc IS NOT NULL, id")
        pending = [row for row in rows if not row["enriched_utc"]
                   or (row["catalog"] in cutoffs and row["enriched_utc"] < cutoffs[row["catalog"]])]
        self.enrich_progress = {"pending": len(pending), "done": 0}
        for row in pending:
            if not self.online:
                return
            started = time.monotonic()
            try:
                payload = await self._get("/api/objects/info", {"name": row["name"], "format": "json"})
            except Exception as error:
                LOG.debug("enrich %s failed: %s", row["name"], error)
                payload = None
            await asyncio.to_thread(self._store_enrichment, row, payload)
            self.enrich_progress["done"] += 1
            # Back off harder if Stellarium is responding slowly (busy rendering).
            elapsed = time.monotonic() - started
            await asyncio.sleep(gap + min(5.0, elapsed * 2))

    def _store_enrichment(self, row: dict, payload: Any) -> None:
        now = utc_now()
        if not isinstance(payload, dict) or payload.get("found") is False:
            self.db.execute("UPDATE phenomena SET enriched_utc = ? WHERE id = ?", (now, row["id"]))
            return
        info = {key: payload[key] for key in INFO_KEEP if key in payload}
        category = row["category"]
        object_type = payload.get("object-type") or payload.get("type")
        # Generic buckets ("deep-sky" from Messier/Caldwell) are refined from
        # Stellarium's own object type.
        if category in ("deep-sky", "planet"):
            category = category_from_stellarium(object_type, category)
        vmag = _num(payload.get("vmag", payload.get("vmage")))
        if vmag is not None and vmag >= 50:  # Stellarium uses 99 for "no magnitude"
            vmag = None
        self.db.execute(
            "UPDATE phenomena SET category = ?, ra_j2000 = ?, dec_j2000 = ?, vmag = ?, constellation = ?, "
            "info_json = ?, enriched_utc = ? WHERE id = ?",
            (category, _num(payload.get("raJ2000")), _num(payload.get("decJ2000")), vmag,
             payload.get("iauConstellation"), json.dumps(info), now, row["id"]),
        )

    # -- control ---------------------------------------------------------------
    def control_snapshot(self) -> dict[str, Any]:
        restore_after = float(self.config.get("control_restore_minutes", 5)) * 60
        active = self.control_saved is not None
        return {
            "enabled": bool(self.config.get("control_pin")),
            "active": active,
            "target": self.control_target,
            "restore_in": max(0, round(restore_after - (time.time() - self.control_last))) if active else None,
        }

    async def _save_view_once(self) -> None:
        if self.control_saved is None:
            if not self.view.get("j2000"):
                raise RuntimeError("Stellarium view is unknown; is Stellarium running?")
            # Save the alt-az direction as well: with Stellarium's default azimuthal
            # mount the view is fixed in alt-az, so that is what must be restored.
            self.control_saved = {"j2000": self.view["j2000"], "altaz": self.view.get("altaz_vec"),
                                  "fov": self.view.get("fov") or 60, "saved_utc": utc_now()}
            LOG.info("Saved Stellarium view before panel control: %s", self.control_saved)
        self.control_last = time.time()

    async def control_focus(self, name: str) -> str:
        await self._save_view_once()
        result = await self._post("/api/main/focus", {"target": name, "mode": "center"})
        self.control_target = name
        return result

    async def control_altaz(self, az: float, alt: float) -> str:
        await self._save_view_once()
        # Clear the selection first, otherwise Stellarium keeps tracking it.
        await self._post("/api/main/focus", {"target": ""})
        vector = astro.azalt_to_stel_altaz_vector(az % 360.0, max(-90.0, min(90.0, alt)))
        result = await self._post("/api/main/view", {"altAz": json.dumps(list(vector))})
        self.control_target = f"AZ {az % 360:.1f} / EL {alt:.1f}"
        return result

    async def control_fov(self, fov: float) -> str:
        await self._save_view_once()
        return await self._post("/api/main/fov", {"fov": f"{max(0.5, min(180.0, fov)):.3f}"})

    async def control_release(self) -> bool:
        saved = self.control_saved
        if saved is None:
            return False
        # If any call fails the saved view is kept so restore_forever retries.
        await self._post("/api/main/focus", {"target": ""})
        if saved.get("altaz"):
            await self._post("/api/main/view", {"altAz": json.dumps(saved["altaz"])})
        else:
            await self._post("/api/main/view", {"j2000": json.dumps(saved["j2000"])})
        await self._post("/api/main/fov", {"fov": f"{float(saved['fov']):.3f}"})
        LOG.info("Restored Stellarium view saved at %s", saved["saved_utc"])
        self.control_saved = None
        self.control_target = None
        return True

    async def restore_forever(self) -> None:
        while True:
            await asyncio.sleep(5)
            if self.control_saved is None:
                continue
            idle = time.time() - self.control_last
            if idle > float(self.config.get("control_restore_minutes", 5)) * 60:
                try:
                    await self.control_release()
                except Exception as error:
                    LOG.warning("Automatic view restore failed (will retry): %s", error)


def _num(value) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _strip_html(text: str) -> str:
    import re
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()
