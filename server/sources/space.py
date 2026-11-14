"""SPACE tab: imagery and posts straight from missions, probes, rovers and
observing satellites (NASA, JAXA, and Japan's Himawari), not general news.

Sources (polled politely; newest kept in the panel DB; images cached on disk):
NASA
* Perseverance and Curiosity raw images - mars.nasa.gov raw-image JSON APIs.
* DSCOVR EPIC - https://epic.gsfc.nasa.gov/api/natural (full Earth from L1).
* SDO - latest Sun images in several channels (sdo.gsfc.nasa.gov).
* SOHO LASCO C2/C3 coronagraphs (ESA/NASA) - soho.nascom.nasa.gov realtime.
* Astronomy Picture of the Day (api.nasa.gov; DEMO_KEY unless nasa_api_key
  is set in config/panel.local.json) and NASA Image of the Day (RSS).
JAXA
* ISAS mission topics (www.isas.jaxa.jp/en/topics/ - Hayabusa2, XRISM, SLIM,
  MMX, ...; the page has no feed, so its topic list is read hourly).
* JAXA press releases, English and Japanese (RSS 1.0).
Japan
* Himawari-9 full disk (operated by JMA; image service by NICT).

Images are fetched by the server and served from a local cache so the page
keeps its strict 'self'-only content policy; only URLs that came from these
sources can be fetched.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp

from ..db import PanelDB, utc_now
from ..net import client_session

LOG = logging.getLogger("panel.space")
IMAGE_HOSTS = ("nasa.gov", "jaxa.jp", "nict.go.jp")
NS = {"rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rss1": "http://purl.org/rss/1.0/",
      "dc": "http://purl.org/dc/elements/1.1/", "content": "http://purl.org/rss/1.0/modules/content/",
      "media": "http://search.yahoo.com/mrss/"}

SOURCES = [
    # --- NASA: rovers, probes and observatories ---
    {"id": "m2020", "agency": "NASA", "group": "MARS ROVERS", "name": "Perseverance raw images", "kind": "m2020", "minutes": 30,
     "url": "https://mars.nasa.gov/rss/api/", "home": "https://mars.nasa.gov/mars2020/multimedia/raw-images/"},
    {"id": "msl", "agency": "NASA", "group": "MARS ROVERS", "name": "Curiosity raw images", "kind": "msl", "minutes": 30,
     "url": "https://mars.nasa.gov/api/v1/raw_image_items/", "home": "https://mars.nasa.gov/msl/multimedia/raw-images/"},
    {"id": "epic", "agency": "NASA", "group": "EARTH", "name": "DSCOVR EPIC · Earth from L1", "kind": "epic", "minutes": 60,
     "url": "https://epic.gsfc.nasa.gov/api/natural", "home": "https://epic.gsfc.nasa.gov/"},
    {"id": "sdo", "agency": "NASA", "group": "SUN", "name": "SDO · the Sun now", "kind": "live", "minutes": 15,
     "home": "https://sdo.gsfc.nasa.gov/data/", "frames": [
        ("AIA 193 Å · corona", "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg"),
        ("AIA 171 Å · quiet corona / upper transition region", "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg"),
        ("AIA 304 Å · chromosphere", "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0304.jpg"),
        ("HMI intensitygram · sunspots", "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg")]},
    {"id": "soho", "agency": "NASA", "group": "SUN", "name": "SOHO LASCO · corona (ESA/NASA)", "kind": "live", "minutes": 30,
     "home": "https://soho.nascom.nasa.gov/data/realtime-images.html", "frames": [
        ("LASCO C2 coronagraph", "https://soho.nascom.nasa.gov/data/realtime/c2/1024/latest.jpg"),
        ("LASCO C3 coronagraph", "https://soho.nascom.nasa.gov/data/realtime/c3/1024/latest.jpg")]},
    {"id": "nasa_apod", "agency": "NASA", "group": "PICTURES", "name": "Astronomy Picture of the Day", "kind": "apod", "minutes": 60,
     "url": "https://api.nasa.gov/planetary/apod", "home": "https://apod.nasa.gov/apod/"},
    {"id": "nasa_iotd", "agency": "NASA", "group": "PICTURES", "name": "Image of the Day", "kind": "rss", "minutes": 30,
     "url": "https://www.nasa.gov/feeds/iotd-feed", "home": "https://www.nasa.gov/image-of-the-day/"},
    # --- JAXA ---
    {"id": "jaxa_isas", "agency": "JAXA", "group": "MISSIONS", "name": "ISAS mission topics", "kind": "isas", "minutes": 60,
     "url": "https://www.isas.jaxa.jp/en/topics/", "home": "https://www.isas.jaxa.jp/en/topics/"},
    {"id": "jaxa_press_en", "agency": "JAXA", "group": "PRESS", "name": "Press releases (English)", "kind": "rdf", "minutes": 60,
     "url": "https://global.jaxa.jp/rss/press.rdf", "home": "https://global.jaxa.jp/press/"},
    {"id": "jaxa_press_jp", "agency": "JAXA", "group": "PRESS", "name": "プレスリリース (Japanese)", "kind": "rdf", "minutes": 60,
     "url": "https://www.jaxa.jp/rss/press_j.rdf", "home": "https://www.jaxa.jp/press/"},
    # --- Japan (non-JAXA) ---
    {"id": "himawari", "agency": "JAPAN", "group": "EARTH", "name": "Himawari-9 full disk (JMA, via NICT)", "kind": "himawari",
     "minutes": 20, "url": "https://himawari8.nict.go.jp/img/D531106/latest.json", "home": "https://himawari8.nict.go.jp/"},
]
SOURCE_IDS = [s["id"] for s in SOURCES]

SCHEMA = """
CREATE TABLE IF NOT EXISTS space_items (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    summary TEXT,
    image_url TEXT,
    media_type TEXT,
    credit TEXT,
    published_utc TEXT,
    fetched_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_space_source ON space_items(source, published_utc);
"""


def clean_text(value: str | None, limit: int = 900) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", value or ""))
    text = re.sub(r"\s+", " ", text.replace(" ", " ")).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def to_utc(value: str | None) -> str | None:
    if not value:
        return None
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00").replace(" ", "T"))
        except ValueError:
            return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat()


def nasa_resized(url: str | None, width: int = 1280) -> str | None:
    """nasa.gov's WordPress media serves resized copies with ?w=; avoid 8 MB originals."""
    if url and "nasa.gov/wp-content/uploads/" in url:
        return re.sub(r"\?.*$", "", url) + f"?w={width}"
    return url


def allowed_image(url: str | None) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and any(host == h or host.endswith("." + h) for h in IMAGE_HOSTS)


def item(key: str, title: str, link: str | None, summary: str = "", image: str | None = None, media: str = "image",
         credit: str | None = None, published: str | None = None) -> dict:
    return {"key": key, "title": title, "link": link, "summary": summary, "image_url": image if allowed_image(image) else None,
            "media_type": media if image else "text", "credit": credit, "published_utc": published}


class SpaceSource:
    def __init__(self, config: dict, db: PanelDB, cache_dir: Path):
        self.config = config
        self.db = db
        self.image_dir = cache_dir / "space_images"
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.status: dict[str, dict] = {s["id"]: {"available": False, "error": None, "fetched": None, "count": 0} for s in SOURCES}
        self._image_locks: dict[str, asyncio.Lock] = {}
        with self.db.transaction() as conn:
            conn.executescript(SCHEMA)
            # drop items from sources that are no longer configured
            conn.execute(f"DELETE FROM space_items WHERE source NOT IN ({','.join('?' * len(SOURCE_IDS))})", SOURCE_IDS)

    # -- polling ---------------------------------------------------------------
    async def run_forever(self) -> None:
        await asyncio.sleep(20)
        last: dict[str, float] = {}
        handlers = {"apod": self._apod, "rss": self._feed, "rdf": self._feed, "m2020": self._m2020, "msl": self._msl,
                    "epic": self._epic, "live": self._live, "isas": self._isas, "himawari": self._himawari}
        async with client_session(aiohttp.ClientTimeout(total=60, connect=15)) as session:
            while True:
                if self.config.get("space_enabled", True):
                    for source in SOURCES:
                        if time.time() - last.get(source["id"], 0) < source["minutes"] * 60:
                            continue
                        last[source["id"]] = time.time()
                        try:
                            items = await handlers[source["kind"]](session, source)
                            await asyncio.to_thread(self._store, source["id"], items)
                            self.status[source["id"]].update(available=True, error=None, fetched=utc_now(), count=len(items))
                        except Exception as error:
                            # keep showing the last good items; just report the failure
                            stored = await asyncio.to_thread(self.db.scalar, "SELECT COUNT(*) FROM space_items WHERE source = ?", (source["id"],))
                            self.status[source["id"]].update(error=str(error)[:200] or error.__class__.__name__, available=bool(stored))
                            LOG.warning("%s fetch failed: %s", source["id"], error)
                        await asyncio.sleep(2)
                    await asyncio.to_thread(self._prune_images)
                await asyncio.sleep(60)

    async def _json(self, session, url, params=None):
        async with session.get(url, params=params) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            return await response.json(content_type=None)

    async def _m2020(self, session, source) -> list[dict]:
        payload = await self._json(session, source["url"], {"feed": "raw_images", "category": "mars2020", "feedtype": "json",
                                                             "num": "36", "page": "0", "order": "sol desc"})
        items = []
        for row in payload.get("images", []):
            if str(row.get("sample_type", "Full")).lower() != "full":
                continue
            files = row.get("image_files") or {}
            camera = (row.get("camera") or {}).get("instrument", "")
            items.append(item(f"m2020:{row.get('imageid')}", row.get("title") or "Perseverance raw image", row.get("link"),
                              clean_text(row.get("caption"), 600) + (f" Instrument: {camera}." if camera else ""),
                              files.get("large") or files.get("medium"), credit="NASA/JPL-Caltech",
                              published=to_utc(row.get("date_taken_utc"))))
        return items

    async def _msl(self, session, source) -> list[dict]:
        payload = await self._json(session, source["url"], {"order": "sol desc", "per_page": "100", "page": "0",
                                                             "condition_1": "msl:mission"})
        items = []
        for row in payload.get("items", []):
            if row.get("is_thumbnail"):
                continue
            link = urljoin("https://mars.nasa.gov/", row.get("link") or "")
            items.append(item(f"msl:{row.get('id')}", row.get("title") or "Curiosity raw image", link,
                              clean_text(row.get("description"), 600) or f"Sol {row.get('sol')} · {row.get('instrument', '')}",
                              row.get("https_url") or row.get("url"), credit=row.get("image_credit") or "NASA/JPL-Caltech",
                              published=to_utc(row.get("date_taken"))))
        return items[:30]

    async def _epic(self, session, source) -> list[dict]:
        rows = await self._json(session, source["url"])
        items = []
        for row in rows[-8:]:
            date = row.get("date", "")
            day = date[:10].replace("-", "/")
            image = f"https://epic.gsfc.nasa.gov/archive/natural/{day}/jpg/{row.get('image')}.jpg"
            items.append(item(f"epic:{row.get('image')}", f"Earth from L1 · {date[:16]} UTC", source["home"],
                              clean_text(row.get("caption"), 400), image, credit="NASA EPIC Team / NOAA DSCOVR",
                              published=to_utc(date + "Z" if date else None)))
        return items

    async def _live(self, session, source) -> list[dict]:
        """Continuously updated 'latest' images: one item per channel, refreshed in place."""
        items = []
        for label, url in source["frames"]:
            async with session.head(url) as response:
                if response.status != 200:
                    continue
                modified = to_utc(response.headers.get("Last-Modified")) or utc_now()
            stamp = int(datetime.fromisoformat(modified).timestamp())
            items.append(item(f"{source['id']}:{label}", label, source["home"],
                              f"Latest {label} image, updated by the observatory every few minutes.",
                              f"{url}?t={stamp}", media="live", credit=source["name"].split("·")[0].strip(), published=modified))
        return items

    async def _himawari(self, session, source) -> list[dict]:
        latest = await self._json(session, source["url"])
        date = latest.get("date")                               # "YYYY-MM-DD HH:MM:SS" UTC
        if not date:
            return []
        moment = datetime.strptime(date, "%Y-%m-%d %H:%M:%S")
        image = f"https://himawari8.nict.go.jp/img/D531106/1d/550/{moment:%Y/%m/%d/%H%M%S}_0_0.png"
        return [item("himawari:full-disk", "Himawari-9 · full disk", source["home"],
                     "True-colour full disk of the Earth from the Himawari-9 geostationary weather satellite at 140.7°E, "
                     "operated by the Japan Meteorological Agency; image service by NICT.", image, media="live",
                     credit="JMA / NICT", published=to_utc(date + "Z"))]

    async def _isas(self, session, source) -> list[dict]:
        async with session.get(source["url"]) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            page = await response.text()
        items = []
        for block in re.findall(r'<div class="topics-list__item[^"]*">(.*?)</div>', page, re.S):
            # topics link to ISAS pages, JAXA press releases, ISAS Cosmos articles or live streams
            link = re.search(r'<a href="((?:https?://|/)[^"]+)"', block)
            title = re.search(r'class="topics-list__txt">\s*<a[^>]*>(.*?)</a>', block, re.S)
            if not link or not title:
                continue
            image = re.search(r'<img src="([^"]+)"', block)
            meta = re.search(r'class="topics-list__meta">(.*?)</p>', block, re.S)
            date_text = clean_text(re.sub(r"<a.*", "", meta.group(1), flags=re.S)) if meta else ""
            tags = [clean_text(t) for t in re.findall(r"<a [^>]*>(.*?)</a>", meta.group(1), re.S)] if meta else []
            try:
                published = datetime.strptime(re.sub(r"\s+", " ", date_text), "%b %d, %Y").replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                published = None
            url = urljoin(source["url"], link.group(1))
            items.append(item(f"isas:{link.group(1)}", clean_text(title.group(1), 300), url,
                              f"Mission tags: {', '.join(tags)}." if tags else "", urljoin(source["url"], image.group(1)) if image else None,
                              credit="JAXA/ISAS", published=published))
        if not items:
            raise RuntimeError("no topics found (page layout may have changed)")
        return items

    async def _apod(self, session, source) -> list[dict]:
        key = self.config.get("nasa_api_key") or "DEMO_KEY"
        start = datetime.now(timezone.utc).date() - timedelta(days=9)
        rows = await self._json(session, source["url"], {"api_key": key, "thumbs": "true", "start_date": start.isoformat()})
        rows = rows if isinstance(rows, list) else [rows]
        items = []
        for row in rows:
            video = row.get("media_type") == "video"
            date = row.get("date")
            items.append(item(f"apod:{date}", row.get("title") or "APOD",
                              f"https://apod.nasa.gov/apod/ap{date[2:4]}{date[5:7]}{date[8:10]}.html" if date else source["home"],
                              clean_text(row.get("explanation"), 1800), row.get("thumbnail_url") if video else row.get("url"),
                              media="video" if video else "image", credit=clean_text(row.get("copyright"), 120) or None,
                              published=f"{date}T12:00:00+00:00" if date else None))
        return items

    async def _feed(self, session, source) -> list[dict]:
        async with session.get(source["url"]) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            data = await response.read()
        # Repair common feed defects before strict parsing: a missing space between
        # attributes (`..."xmlns:media=`) and bare ampersands.
        data = re.sub(rb'"(?=xmlns:)', b'" ', data)
        data = re.sub(rb"&(?!#?\w+;)", b"&amp;", data)
        root = ET.fromstring(data)
        items = []
        if source["kind"] == "rdf":
            for entry in root.findall("rss1:item", NS):
                link = (entry.findtext("rss1:link", default="", namespaces=NS) or entry.get(f"{{{NS['rdf']}}}about") or "").strip()
                items.append(item(f"{source['id']}:{link}", clean_text(entry.findtext("rss1:title", "", NS), 300), link,
                                  clean_text(entry.findtext("rss1:description", "", NS)), None, credit="JAXA",
                                  published=to_utc(entry.findtext("dc:date", None, NS))))
            return items
        for entry in root.iter("item"):
            link = (entry.findtext("link") or "").strip()
            guid = (entry.findtext("guid") or link).strip()
            image = None
            enclosure = entry.find("enclosure")
            if enclosure is not None and (enclosure.get("type") or "").startswith("image"):
                image = enclosure.get("url")
            body = entry.findtext("content:encoded", None, NS) or entry.findtext("description") or ""
            if not image:
                match = re.search(r'<img[^>]+src="([^"]+)"', body)
                image = html.unescape(match.group(1)) if match else None
            items.append(item(f"{source['id']}:{guid}", clean_text(entry.findtext("title"), 300), link,
                              clean_text(entry.findtext("description") or body), nasa_resized(image),
                              credit=clean_text(entry.findtext("dc:creator", None, NS), 120) or "NASA",
                              published=to_utc(entry.findtext("pubDate"))))
        return items

    def _store(self, source_id: str, items: list[dict]) -> None:
        keep = int(self.config.get("space_items_per_source", 120))
        with self.db.transaction() as conn:
            for entry in items:
                conn.execute(
                    "INSERT INTO space_items(key, source, title, link, summary, image_url, media_type, credit, published_utc, fetched_utc) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET title = excluded.title, "
                    "summary = excluded.summary, image_url = COALESCE(excluded.image_url, image_url), "
                    "media_type = excluded.media_type, credit = excluded.credit, "
                    "published_utc = COALESCE(excluded.published_utc, published_utc), fetched_utc = excluded.fetched_utc",
                    (entry["key"], source_id, entry["title"], entry["link"], entry["summary"], entry["image_url"],
                     entry["media_type"], entry["credit"], entry["published_utc"], utc_now()))
            conn.execute("DELETE FROM space_items WHERE source = ? AND key NOT IN "
                         "(SELECT key FROM space_items WHERE source = ? ORDER BY published_utc DESC LIMIT ?)",
                         (source_id, source_id, keep))

    # -- images -----------------------------------------------------------------
    def image_path(self, url: str) -> Path:
        return self.image_dir / f"{hashlib.sha1(url.encode()).hexdigest()}.img"

    async def image(self, key: str) -> tuple[Path, str] | None:
        row = await asyncio.to_thread(self.db.one, "SELECT image_url FROM space_items WHERE key = ?", (key,))
        url = row and row["image_url"]
        if not allowed_image(url):
            return None
        path = self.image_path(url)
        meta = path.with_suffix(".type")
        lock = self._image_locks.setdefault(url, asyncio.Lock())
        async with lock:
            if not path.exists():
                async with client_session(aiohttp.ClientTimeout(total=90, connect=15)) as session:
                    async with session.get(url) as response:
                        content_type = response.headers.get("Content-Type", "")
                        if response.status != 200 or not content_type.startswith("image/"):
                            return None
                        data = await response.read()
                if len(data) > int(self.config.get("space_image_max_bytes", 12_000_000)):
                    return None
                path.write_bytes(data)
                meta.write_text(content_type.split(";")[0], encoding="utf-8")
        self._image_locks.pop(url, None)
        return path, (meta.read_text(encoding="utf-8") if meta.exists() else "image/jpeg")

    def _prune_images(self) -> None:
        cap = int(self.config.get("space_image_cache_mb", 400)) * 1024 * 1024
        files = sorted(self.image_dir.glob("*.img"), key=lambda p: p.stat().st_atime)
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if total <= cap:
                break
            total -= path.stat().st_size
            path.unlink(missing_ok=True)
            path.with_suffix(".type").unlink(missing_ok=True)

    # -- views --------------------------------------------------------------------
    def sources(self) -> list[dict]:
        counts = {r["source"]: r["n"] for r in self.db.query("SELECT source, COUNT(*) AS n FROM space_items GROUP BY source")}
        return [{**{k: s[k] for k in ("id", "agency", "group", "name", "home")}, "stored": counts.get(s["id"], 0), **self.status[s["id"]]}
                for s in SOURCES]

    def items(self, source: str | None, agency: str | None, limit: int, offset: int) -> dict[str, Any]:
        where, args = [], []
        if source:
            where.append("source = ?")
            args.append(source)
        elif agency:
            ids = [s["id"] for s in SOURCES if s["agency"] == agency]
            where.append(f"source IN ({','.join('?' * len(ids))})")
            args += ids
        clause = f"WHERE {' AND '.join(where)}" if where else "WHERE 1=1"
        # cross-posted stories: across feeds show each title once (prefer a copy with an image)
        dedupe = "" if source else (
            f" AND key IN (SELECT key FROM (SELECT key, ROW_NUMBER() OVER (PARTITION BY lower(title), source LIKE 'jaxa_press%' "
            f"ORDER BY image_url IS NULL, published_utc DESC) AS rn FROM space_items {clause}) WHERE rn = 1)")
        full_args = args + (args if dedupe else [])
        rows = self.db.query(f"SELECT key, source, title, link, summary, image_url IS NOT NULL AS has_image, media_type, credit, "
                             f"published_utc FROM space_items {clause}{dedupe} ORDER BY published_utc DESC LIMIT ? OFFSET ?",
                             full_args + [limit, offset])
        names = {s["id"]: (s["agency"], s["name"], s["group"]) for s in SOURCES}
        for row in rows:
            row["agency"], row["source_name"], row["group"] = names.get(row["source"], ("", row["source"], ""))
        return {"total": self.db.scalar(f"SELECT COUNT(*) FROM space_items {clause}{dedupe}", full_args), "items": rows}
