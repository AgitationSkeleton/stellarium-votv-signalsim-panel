from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aiohttp import web

from . import __version__, astro
from .config import DATA_DIR, ROOT, STATIC_DIR, load_config, setup_logging
from .db import PanelDB
from .security import SESSION_COOKIE, SESSION_SECONDS, Guard, build_middleware
from .sources.rtlsdr import RtlSdrSource
from .sources.shortwave import REGION_CENTRES, ShortwaveSource
from .sources.space import SOURCES as SPACE_SOURCES, SpaceSource
from .stellarium import StellariumService
from .sysstats import SystemService
from .taxonomy import CATEGORY_NOTES, model_for, planet_class

LOG = logging.getLogger("panel")
NO_MAG_CATEGORIES = {"radio source", "pulsar", "seti signal", "probe", "constellation", "meteor shower"}
SOLAR_CATEGORIES = {"planet", "moon"}

routes = web.RouteTableDef()


class Panel:
    def __init__(self) -> None:
        self.config = load_config()
        self.db = PanelDB(DATA_DIR / "panel.sqlite3")
        self.guard = Guard(self.config)
        self.stellarium = StellariumService(self.config, self.db)
        self.system = SystemService(self.config, self.db)
        self.sdr = RtlSdrSource(self.config, self.db)
        self.shortwave = ShortwaveSource(self.config)
        self.space = SpaceSource(self.config, self.db, DATA_DIR / "cache")
        self.started = time.time()
        self._sky_cache: tuple[float, dict] | None = None
        self._state_cache: tuple[float, dict] | None = None
        self.capture_pattern = re.compile(self.config.get("screenshot_pattern") or r"^stellarium.*\.(jpe?g|png)$", re.IGNORECASE)
        self.tasks: list[asyncio.Task] = []

    def seed_curated(self) -> None:
        payload = json.loads((ROOT / "server" / "catalog_curated.json").read_text(encoding="utf-8"))
        with self.db.transaction() as conn:
            for item in payload["objects"]:
                PanelDB.upsert_phenomenon(
                    conn, key=f"curated:{astro.normalize_name(item['name'])}", name=item["name"],
                    category=item["category"], source="curated", catalog="Radio & SETI targets",
                    ra=item.get("ra"), dec=item.get("dec"), description=item.get("description"),
                    approximate=bool(item.get("approximate")))

    async def start(self, app: web.Application) -> None:
        await asyncio.to_thread(self.seed_curated)
        await self.stellarium.start()
        jobs = [
            self.stellarium.poll_forever(), self.stellarium.solar_forever(), self.stellarium.catalog_forever(),
            self.stellarium.restore_forever(), self.system.sample_forever(), self.system.temperature_forever(),
            self.sdr.run_forever(), self.shortwave.run_forever(), self.space.run_forever(),
        ]
        self.tasks = [asyncio.create_task(job) for job in jobs]
        LOG.info("Panel %s started", __version__)

    async def stop(self, app: web.Application) -> None:
        if self.stellarium.control_saved:
            try:
                await self.stellarium.control_release()
            except Exception as error:
                LOG.warning("Could not restore Stellarium view on shutdown: %s", error)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.stellarium.close()
        self.db.close()

    # -- shared helpers -------------------------------------------------------
    def location(self) -> dict:
        return self.stellarium.location

    def decorate(self, row: dict) -> dict:
        row = dict(row)
        if row.get("info_json"):
            try:
                row["info"] = json.loads(row["info_json"])
            except ValueError:
                row["info"] = {}
        row.pop("info_json", None)
        row["model"] = model_for(row["category"], row["name"])
        if row["category"] == "planet":
            row["planet_class"] = planet_class(row["name"])
        return row

    def position_now(self, row: dict) -> dict | None:
        live = self.stellarium.solar.get(row["name"])
        if live and live.get("az") is not None:
            return {"az": live["az"], "alt": live["alt"], "live": True}
        if row.get("ra_j2000") is None or row.get("dec_j2000") is None:
            return None
        loc = self.location()
        az, alt = astro.radec_to_altaz(row["ra_j2000"], row["dec_j2000"], loc["latitude"], loc["longitude"],
                                       datetime.now(timezone.utc))
        return {"az": az, "alt": alt, "live": False}

    def sky(self, mag_limit: float, include_below: bool, own_only: bool = False) -> dict:
        """Objects above the horizon. own_only keeps only objects you have selected in Stellarium."""
        cache_key = (mag_limit, own_only)
        if self._sky_cache and time.time() - self._sky_cache[0] < 15 and not include_below:
            cached = self._sky_cache[1]
            if cached.get("_key") == cache_key:
                return cached
        loc = self.location()
        now = datetime.now(timezone.utc)
        objects = []
        for row in self.db.query("SELECT id, name, category, ra_j2000, dec_j2000, vmag, approximate, sightings "
                                 "FROM phenomena WHERE ra_j2000 IS NOT NULL AND category NOT IN ('satellite')"):
            if row["category"] in SOLAR_CATEGORIES or row["name"] in self.stellarium.solar:
                continue
            if own_only and not row["sightings"]:
                continue
            if row["category"] not in NO_MAG_CATEGORIES and (row["vmag"] is None or row["vmag"] > mag_limit):
                continue
            az, alt = astro.radec_to_altaz(row["ra_j2000"], row["dec_j2000"], loc["latitude"], loc["longitude"], now)
            if alt < -2 and not include_below:
                continue
            objects.append({"id": row["id"], "name": row["name"], "category": row["category"], "az": az, "alt": alt,
                            "vmag": row["vmag"], "approximate": bool(row["approximate"]),
                            "sightings": row["sightings"], "model": model_for(row["category"], row["name"])})
        solar_rows = {r["name"]: r for r in self.db.query(
            "SELECT id, name, sightings FROM phenomena WHERE key IN ('sun','moon') OR category IN ('planet', 'moon')")}
        for name, live in self.stellarium.solar.items():
            if live.get("alt") is None or (live["alt"] < -2 and not include_below):
                continue
            if own_only and not (solar_rows.get(name) or {}).get("sightings"):
                continue
            category = "moon" if name == "Moon" else "planet"
            objects.append({"id": (solar_rows.get(name) or {}).get("id"), "name": name, "category": category,
                            "az": live["az"], "alt": live["alt"], "vmag": live.get("vmag"), "live": True,
                            "model": model_for(category, name)})
        result = {"generated": now.isoformat(), "location": loc, "view": self.stellarium.view,
                  "mag_limit": mag_limit, "own_only": own_only, "_key": cache_key, "objects": objects}
        if not include_below:
            self._sky_cache = (time.time(), result)
        return result

    def latest_capture(self) -> Path | None:
        newest: tuple[float, Path] | None = None
        for directory in self.config.get("screenshot_dirs", []):
            try:
                for entry in os.scandir(directory):
                    if entry.is_file() and self.capture_pattern.match(entry.name):
                        mtime = entry.stat().st_mtime
                        if newest is None or mtime > newest[0]:
                            newest = (mtime, Path(entry.path))
            except OSError:
                continue
        return newest[1] if newest else None


def panel_of(request: web.Request) -> Panel:
    return request.app["panel"]


def _int(value, default: int, low: int = 0, high: int = 10_000) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


async def run_db(func, *args):
    return await asyncio.to_thread(func, *args)


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@routes.get("/")
async def index(request: web.Request):
    return web.FileResponse(STATIC_DIR / "index.html")


@routes.get("/api/health")
async def health(request: web.Request):
    return web.json_response({"ok": True, "version": __version__})


# ---------------------------------------------------------------------------
# Live state (polled every couple of seconds by every screen)
# ---------------------------------------------------------------------------
@routes.get("/api/state")
async def state(request: web.Request):
    panel = panel_of(request)
    cached = panel._state_cache
    if cached and time.time() - cached[0] < 1.5:
        return web.json_response({**cached[1], "auth": panel.guard.is_authenticated(request)})
    payload = await build_state(panel)
    panel._state_cache = (time.time(), payload)
    return web.json_response({**payload, "auth": panel.guard.is_authenticated(request)})


async def build_state(panel: Panel) -> dict:

    def build() -> dict[str, Any]:
        day_ago = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        return {
            "rf_events_24h": panel.db.scalar("SELECT COUNT(*) FROM sdr_events WHERE timestamp_utc >= ?", (day_ago,)),
            "sightings_24h": panel.db.scalar("SELECT COUNT(*) FROM sightings WHERE observed_utc >= ?", (day_ago,)),
            "phenomena_total": panel.db.scalar("SELECT COUNT(*) FROM phenomena"),
        }

    counters = await run_db(build)
    view = panel.stellarium.view
    in_view = None
    if view.get("az") is not None:
        sky = await run_db(panel.sky, 7.0, False, False)
        radius = (view.get("fov") or 60) / 2
        in_view = sum(1 for obj in sky["objects"]
                      if astro.angular_separation(view["az"], view["alt"], obj["az"], obj["alt"]) <= radius)
    system = panel.system.current
    return {
        "server_time": datetime.now(timezone.utc).isoformat(),
        "version": __version__,
        "stellarium": panel.stellarium.snapshot(),
        "pc": {
            "cpu": system.get("cpu"), "memory": (system.get("memory") or {}).get("percent"),
            "net_rx_bps": (system.get("net") or {}).get("rx_bps"), "net_tx_bps": (system.get("net") or {}).get("tx_bps"),
            "temperature": system.get("temperature"), "uptime_seconds": system.get("uptime_seconds"),
            "disk": ((system.get("disks") or [{}])[0]).get("percent"),
        },
        "services": {key: value.get("running") for key, value in (panel.system.services.get("services") or {}).items()},
        "sources": {"rtlsdr": panel.sdr.snapshot()},
        "objects_in_view": in_view,
        "latest_sighting": panel.stellarium.latest_selection,
        "latest_rf": panel.sdr.latest_event,
        **counters,
    }


@routes.get("/api/sky")
async def sky(request: web.Request):
    panel = panel_of(request)
    mag = max(-30.0, min(20.0, _float(request.query.get("mag"), 7.0)))
    below = request.query.get("below") == "1"
    own = request.query.get("own") == "1"
    data = await run_db(panel.sky, mag, below, own)
    return web.json_response({k: v for k, v in data.items() if k != "_key"})


@routes.get("/api/feed")
async def feed(request: web.Request):
    """Recent happenings: your Stellarium selections and new RTL-SDR events (ticker + auto cycle)."""
    panel = panel_of(request)
    limit = _int(request.query.get("limit"), 40, 1, 200)

    def build():
        sightings = panel.db.query(
            "SELECT MAX(s.observed_utc) AS t, 'sighting' AS kind, s.source AS source, p.id AS phenomenon_id, p.name, "
            "p.category, p.sightings FROM sightings s JOIN phenomena p ON p.id = s.phenomenon_id "
            "GROUP BY p.id ORDER BY t DESC LIMIT ?", (limit,))
        rf = panel.db.query(
            "SELECT timestamp_utc AS t, 'rf event' AS kind, 'rtlsdr' AS source, id AS rf_id, band, "
            "center_hz, score, classification FROM sdr_events ORDER BY id DESC LIMIT ?", (limit,))
        items = sightings + rf
        for item in items:
            item["model"] = "signal" if item["kind"] == "rf event" else model_for(item["category"], item["name"])
        items.sort(key=lambda item: item["t"] or "", reverse=True)
        return items[:limit]

    return web.json_response({"items": await run_db(build)})


# ---------------------------------------------------------------------------
# Phenomena database
# ---------------------------------------------------------------------------
SORTS = {
    "recent": "last_seen_utc IS NULL, last_seen_utc DESC, name",
    "sightings": "sightings DESC, name",
    "name": "name COLLATE NOCASE",
    "magnitude": "vmag IS NULL, vmag, name",
    "added": "id DESC",
}


@routes.get("/api/phenomena")
async def phenomena(request: web.Request):
    panel = panel_of(request)
    q = (request.query.get("q") or "").strip()[:80]
    category = request.query.get("category") or ""
    source = request.query.get("source") or ""
    seen_only = request.query.get("seen") == "1" or request.query.get("own") == "1"
    sort = SORTS.get(request.query.get("sort") or "recent", SORTS["recent"])
    limit = _int(request.query.get("limit"), 60, 1, 500)
    offset = _int(request.query.get("offset"), 0, 0, 1_000_000)
    where, args = [], []
    if q:
        where.append("(name LIKE ? OR constellation LIKE ? OR catalog LIKE ?)")
        args += [f"%{q}%"] * 3
    if category:
        where.append("category = ?")
        args.append(category)
    if source:
        where.append("source = ?")
        args.append(source)
    if seen_only:
        where.append("sightings > 0")
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    def build():
        total = panel.db.scalar(f"SELECT COUNT(*) FROM phenomena {clause}", args)
        rows = panel.db.query(
            f"SELECT id, name, category, catalog, source, vmag, constellation, sightings, first_seen_utc, "
            f"last_seen_utc, approximate, ra_j2000, dec_j2000 FROM phenomena {clause} ORDER BY {sort} LIMIT ? OFFSET ?",
            args + [limit, offset])
        for row in rows:
            row["model"] = model_for(row["category"], row["name"])
            position = panel.position_now(row)
            row["alt"] = position["alt"] if position else None
            row["az"] = position["az"] if position else None
            row.pop("ra_j2000"), row.pop("dec_j2000")
        categories = panel.db.query("SELECT category, COUNT(*) AS n, SUM(sightings > 0) AS seen FROM phenomena "
                                    + ("WHERE sightings > 0 " if seen_only else "") +
                                    "GROUP BY category ORDER BY n DESC")
        return {"total": total, "items": rows, "categories": categories}

    return web.json_response(await run_db(build))


@routes.get(r"/api/phenomena/{pid:\d+}")
async def phenomenon(request: web.Request):
    panel = panel_of(request)
    pid = int(request.match_info["pid"])

    def build():
        row = panel.db.one("SELECT * FROM phenomena WHERE id = ?", (pid,))
        if not row:
            return None
        row = panel.decorate(row)
        row["notes"] = row.get("description") or CATEGORY_NOTES.get(row["category"], "")
        row["position"] = panel.position_now(row)
        row["recent_sightings"] = panel.db.query(
            "SELECT observed_utc, source, detail_json FROM sightings WHERE phenomenon_id = ? "
            "ORDER BY observed_utc DESC LIMIT 40", (pid,))
        since = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        row["daily"] = panel.db.query(
            "SELECT substr(observed_utc, 1, 10) AS day, COUNT(*) AS n FROM sightings "
            "WHERE phenomenon_id = ? AND observed_utc >= ? GROUP BY day ORDER BY day", (pid, since))
        return row

    row = await run_db(build)
    if row is None:
        raise web.HTTPNotFound()
    if row["category"] not in ("seti signal", "probe", "radio source", "pulsar"):
        live = await panel.stellarium.info(row["name"])
        if live:
            row["live"] = {key: live.get(key) for key in (
                "altitude", "azimuth", "vmag", "distance", "distance-km", "rise", "set", "transit",
                "illumination", "phase", "iauConstellation", "object-type", "above-horizon", "size-deg",
                "heliocentric-distance", "velocity", "zhr", "activity", "population-index", "parent") if key in live}
            if live.get("azimuth") is not None:
                row["position"] = {**(row.get("position") or {}), "az": live["azimuth"], "alt": live["altitude"],
                                   "live": True}
    return web.json_response(row)


@routes.get("/api/stats/overview")
async def overview(request: web.Request):
    panel = panel_of(request)
    own = request.query.get("own") == "1"
    own_clause = " WHERE sightings > 0" if own else ""

    def build():
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        daily = panel.db.query(
            "SELECT substr(observed_utc, 1, 10) AS day, source, COUNT(*) AS n FROM sightings "
            "WHERE observed_utc >= ? GROUP BY day, source ORDER BY day", (since,))
        top = panel.db.query(
            "SELECT id, name, category, sightings, last_seen_utc FROM phenomena "
            "WHERE sightings > 0 ORDER BY sightings DESC LIMIT 15")
        for row in top:
            row["model"] = model_for(row["category"], row["name"])
        return {
            "phenomena": panel.db.scalar("SELECT COUNT(*) FROM phenomena" + own_clause),
            "own_only": own,
            "seen": panel.db.scalar("SELECT COUNT(*) FROM phenomena WHERE sightings > 0"),
            "sightings": panel.db.scalar("SELECT COUNT(*) FROM sightings"),
            "rf_events": panel.db.scalar("SELECT COUNT(*) FROM sdr_events"),
            "by_category": panel.db.query("SELECT category, COUNT(*) AS n, SUM(sightings) AS sightings "
                                          "FROM phenomena" + own_clause + " GROUP BY category ORDER BY n DESC"),
            "daily": daily, "top": top,
            "first_sighting": panel.db.scalar("SELECT MIN(observed_utc) FROM sightings"),
        }

    return web.json_response(await run_db(build))


# ---------------------------------------------------------------------------
# RTL-SDR (rtl_power band monitor)
# ---------------------------------------------------------------------------
@routes.get("/api/rf/events")
async def rf_events(request: web.Request):
    panel = panel_of(request)
    limit = _int(request.query.get("limit"), 50, 1, 500)
    offset = _int(request.query.get("offset"), 0, 0, 1_000_000)
    where, args = [], []
    if request.query.get("band"):
        where.append("band = ?")
        args.append(request.query["band"])
    if request.query.get("min_score"):
        where.append("score >= ?")
        args.append(_float(request.query["min_score"], 0))
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    def build():
        return {
            "total": panel.db.scalar(f"SELECT COUNT(*) FROM sdr_events {clause}", args),
            "items": panel.db.query(f"SELECT * FROM sdr_events {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
                                    args + [limit, offset]),
        }

    return web.json_response(await run_db(build))


@routes.get(r"/api/rf/events/{eid:\d+}")
async def rf_event(request: web.Request):
    panel = panel_of(request)
    row = await run_db(panel.db.one, "SELECT * FROM sdr_events WHERE id = ?", (int(request.match_info["eid"]),))
    if not row:
        raise web.HTTPNotFound()
    spectrum = panel.sdr.spectra.get(row["band"])
    row["spectrum"] = spectrum
    return web.json_response(row)


@routes.get("/api/rf/summary")
async def rf_summary(request: web.Request):
    panel = panel_of(request)

    def build():
        since = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        return {
            "total": panel.db.scalar("SELECT COUNT(*) FROM sdr_events"),
            "first": panel.db.scalar("SELECT MIN(timestamp_utc) FROM sdr_events"),
            "sweeps": panel.db.scalar("SELECT COUNT(*) FROM sdr_sweeps"),
            "by_band": panel.db.query("SELECT band, COUNT(*) AS n, AVG(score) AS avg_score, MAX(score) AS max_score "
                                      "FROM sdr_events GROUP BY band ORDER BY n DESC"),
            "daily": panel.db.query("SELECT substr(timestamp_utc, 1, 10) AS day, COUNT(*) AS n "
                                    "FROM sdr_events WHERE timestamp_utc >= ? GROUP BY day ORDER BY day", (since,)),
            "hourly": panel.db.query("SELECT CAST(substr(timestamp_utc, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n "
                                     "FROM sdr_events GROUP BY hour ORDER BY hour"),
            "top": panel.db.query("SELECT id, timestamp_utc, band, center_hz, score, classification FROM sdr_events "
                                  "ORDER BY score DESC LIMIT 10"),
        }

    data = await run_db(build)
    data["status"] = panel.sdr.snapshot()
    return web.json_response(data)


@routes.get("/api/rf/bands")
async def rf_bands(request: web.Request):
    panel = panel_of(request)
    hours = max(1.0, min(24 * 14, _float(request.query.get("hours"), 24)))
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    rows = await run_db(panel.db.query, "SELECT timestamp_utc, band, floor_db, active_bins FROM sdr_sweeps "
                                        "WHERE timestamp_utc >= ? ORDER BY timestamp_utc", (since,))
    series: dict[str, list] = {}
    for row in rows:
        series.setdefault(row["band"], []).append({"t": row["timestamp_utc"], "noise": row["floor_db"],
                                                   "active": row["active_bins"]})
    return web.json_response({"series": series, "last_sweep_age": panel.sdr.last_sweep_age(),
                              "status": panel.sdr.snapshot()})


@routes.get("/api/rf/spectrum")
async def rf_spectrum(request: web.Request):
    panel = panel_of(request)
    band = request.query.get("band") or ""
    spectra = panel.sdr.spectra
    if band:
        return web.json_response({"band": band, "spectrum": spectra.get(band)})
    return web.json_response({"bands": {name: spectrum for name, spectrum in spectra.items()}})


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------
@routes.get("/api/system")
async def system(request: web.Request):
    panel = panel_of(request)
    data = panel.system.snapshot()
    data["sources"] = {"rtlsdr": panel.sdr.snapshot(),
                       "stellarium": {"available": panel.stellarium.online, "error": panel.stellarium.last_error}}
    data["panel_uptime_seconds"] = time.time() - panel.started
    db_path = DATA_DIR / "panel.sqlite3"
    data["panel_db_bytes"] = db_path.stat().st_size if db_path.exists() else 0
    return web.json_response(data)


@routes.get("/api/system/history")
async def system_history(request: web.Request):
    panel = panel_of(request)
    hours = max(0.5, min(24 * 14, _float(request.query.get("hours"), 24)))
    return web.json_response({"items": await run_db(panel.system.history, hours)})


# ---------------------------------------------------------------------------
# Latest Stellarium screenshot (read-only, from screenshot_dirs)
# ---------------------------------------------------------------------------
@routes.get("/api/capture/info")
async def capture_info(request: web.Request):
    panel = panel_of(request)
    if not panel.config.get("screenshot_dirs"):
        return web.json_response({"available": False, "configured": False})
    path = await asyncio.to_thread(panel.latest_capture)
    if not path:
        return web.json_response({"available": False, "configured": True})
    stat = path.stat()
    return web.json_response({"available": True, "configured": True, "name": path.name,
                              "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                              "bytes": stat.st_size})


@routes.get("/api/capture/latest")
async def capture_latest(request: web.Request):
    path = await asyncio.to_thread(panel_of(request).latest_capture)
    if not path:
        raise web.HTTPNotFound()
    response = web.FileResponse(path)
    response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# Auth + Stellarium control
# ---------------------------------------------------------------------------
async def _json_body(request: web.Request) -> dict:
    if request.content_length and request.content_length > 4096:
        raise web.HTTPRequestEntityTooLarge(max_size=4096, actual_size=request.content_length)
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="invalid JSON")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="invalid JSON")
    return body


@routes.get("/api/auth/status")
async def auth_status(request: web.Request):
    panel = panel_of(request)
    return web.json_response({"authenticated": panel.guard.is_authenticated(request),
                              "control_enabled": panel.guard.control_enabled(),
                              "restore_minutes": panel.config.get("control_restore_minutes", 5)})


@routes.post("/api/auth/login")
async def auth_login(request: web.Request):
    panel = panel_of(request)
    body = await _json_body(request)
    token = panel.guard.login(request.remote or "?", str(body.get("pin", ""))[:64])
    if not token:
        LOG.warning("Failed control PIN attempt from %s", request.remote)
        return web.json_response({"ok": False, "error": "PIN rejected"}, status=401)
    LOG.info("Control session opened from %s", request.remote)
    response = web.json_response({"ok": True})
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite="Strict", path="/")
    return response


@routes.post("/api/auth/logout")
async def auth_logout(request: web.Request):
    panel_of(request).guard.logout(request)
    response = web.json_response({"ok": True})
    response.del_cookie(SESSION_COOKIE, path="/")
    return response


def require_control(request: web.Request) -> Panel:
    panel = panel_of(request)
    if not panel.guard.control_enabled():
        raise web.HTTPForbidden(text="Control is disabled (no PIN configured).")
    if not panel.guard.is_authenticated(request):
        raise web.HTTPUnauthorized(text="Enter the control PIN first.")
    if not panel.stellarium.online:
        raise web.HTTPServiceUnavailable(text="Stellarium is offline.")
    return panel


@routes.get("/api/control/search")
async def control_search(request: web.Request):
    panel = panel_of(request)
    return web.json_response({"results": await panel.stellarium.find(request.query.get("q") or "")})


@routes.post("/api/control/focus")
async def control_focus(request: web.Request):
    panel = require_control(request)
    name = str((await _json_body(request)).get("name", "")).strip()[:120]
    if not name:
        raise web.HTTPBadRequest(text="name required")
    result = await panel.stellarium.control_focus(name)
    LOG.info("%s focused Stellarium on %s (%s)", request.remote, name, result)
    return web.json_response({"ok": result.lower() in ("ok", "true"), "result": result, "control": panel.stellarium.control_snapshot()})


@routes.post("/api/control/altaz")
async def control_altaz(request: web.Request):
    panel = require_control(request)
    body = await _json_body(request)
    az, alt = _float(body.get("az"), float("nan")), _float(body.get("alt"), float("nan"))
    if az != az or alt != alt:
        raise web.HTTPBadRequest(text="az and alt required")
    result = await panel.stellarium.control_altaz(az, alt)
    return web.json_response({"ok": True, "result": result, "control": panel.stellarium.control_snapshot()})


@routes.post("/api/control/fov")
async def control_fov(request: web.Request):
    panel = require_control(request)
    fov = _float((await _json_body(request)).get("fov"), float("nan"))
    if fov != fov:
        raise web.HTTPBadRequest(text="fov required")
    result = await panel.stellarium.control_fov(fov)
    return web.json_response({"ok": True, "result": result, "control": panel.stellarium.control_snapshot()})


@routes.post("/api/control/release")
async def control_release(request: web.Request):
    panel = require_control(request)
    restored = await panel.stellarium.control_release()
    return web.json_response({"ok": True, "restored": restored, "control": panel.stellarium.control_snapshot()})


# ---------------------------------------------------------------------------
# Shortwave / numbers stations (Priyom schedule + public SDR tuning links)
# ---------------------------------------------------------------------------
@routes.get("/api/shortwave")
async def shortwave_overview(request: web.Request):
    panel = panel_of(request)
    hours = max(1.0, min(36.0, _float(request.query.get("hours"), 12)))
    return web.json_response(panel.shortwave.overview(hours))


@routes.get("/api/shortwave/tune")
async def shortwave_tune(request: web.Request):
    panel = panel_of(request)
    freq = _float(request.query.get("freq"), float("nan"))
    if not (0 < freq <= 30000):
        raise web.HTTPBadRequest(text="freq must be 0-30000 kHz")
    mode = (request.query.get("mode") or "USB").upper()
    if mode not in ("USB", "LSB", "AM", "CW", "USB/AM", "RTTY", "RTTY/CW", "FM"):
        mode = "USB"
    target = request.query.get("target") or None
    if target not in REGION_CENTRES:
        target = None
    return web.json_response({"freq_khz": freq, "mode": mode, "target": target,
                              "links": panel.shortwave.tune(freq, mode, target)})


# ---------------------------------------------------------------------------
# Space (NASA / JAXA feeds)
# ---------------------------------------------------------------------------
@routes.get("/api/space/sources")
async def space_sources(request: web.Request):
    return web.json_response({"sources": await run_db(panel_of(request).space.sources)})


@routes.get("/api/space/items")
async def space_items(request: web.Request):
    panel = panel_of(request)
    ids = {s["id"] for s in SPACE_SOURCES}
    source = request.query.get("source") or None
    agency = request.query.get("agency") or None
    if source not in ids:
        source = None
    if agency not in ("NASA", "JAXA", "JAPAN"):
        agency = None
    limit = _int(request.query.get("limit"), 30, 1, 120)
    offset = _int(request.query.get("offset"), 0, 0, 100000)
    return web.json_response(await run_db(panel.space.items, source, agency, limit, offset))


@routes.get("/api/space/image")
async def space_image(request: web.Request):
    """Serves only images whose URL came from the feeds (looked up by item key)."""
    key = (request.query.get("key") or "")[:600]
    result = await panel_of(request).space.image(key) if key else None
    if not result:
        raise web.HTTPNotFound()
    path, content_type = result
    response = web.FileResponse(path, headers={"Content-Type": content_type})
    response.headers["Cache-Control"] = "private, max-age=604800, immutable"
    return response


# ---------------------------------------------------------------------------
def create_app() -> web.Application:
    setup_logging()
    panel = Panel()
    app = web.Application(middlewares=[build_middleware(panel.guard)], client_max_size=64 * 1024)
    app["panel"] = panel
    app.add_routes(routes)
    app.router.add_static("/static", STATIC_DIR, show_index=False, follow_symlinks=False)
    app.on_startup.append(panel.start)
    app.on_cleanup.append(panel.stop)
    return app


def main() -> None:
    app = create_app()
    config = app["panel"].config
    if not app["panel"].guard.control_enabled():
        LOG.warning("No control PIN configured (config/panel.local.json); Stellarium control is disabled.")
    port = int(config["listen_port"])
    web.run_app(app, host=config["listen_host"], port=port, access_log=None,
                print=lambda *_: LOG.info("Panel running: open http://localhost:%s on this machine, or "
                                          "http://<this-computer's-LAN-address>:%s from another device", port, port))
