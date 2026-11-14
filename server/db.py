"""The panel's own SQLite archive: the object catalogue (seeded from Stellarium
and a small curated list), your logged selections ("sightings"), RTL-SDR sweeps
and events, and PC history."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS phenomena (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    catalog TEXT,
    source TEXT NOT NULL,
    ra_j2000 REAL,
    dec_j2000 REAL,
    vmag REAL,
    constellation TEXT,
    description TEXT,
    info_json TEXT,
    approximate INTEGER NOT NULL DEFAULT 0,
    sightings INTEGER NOT NULL DEFAULT 0,
    first_seen_utc TEXT,
    last_seen_utc TEXT,
    enriched_utc TEXT,
    created_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phen_category ON phenomena(category);
CREATE INDEX IF NOT EXISTS idx_phen_last_seen ON phenomena(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_phen_name ON phenomena(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sightings (
    id INTEGER PRIMARY KEY,
    phenomenon_id INTEGER NOT NULL REFERENCES phenomena(id),
    observed_utc TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    detail_json TEXT,
    UNIQUE(source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_sight_phen ON sightings(phenomenon_id, observed_utc);
CREATE INDEX IF NOT EXISTS idx_sight_time ON sightings(observed_utc);

CREATE TABLE IF NOT EXISTS sdr_events (
    id INTEGER PRIMARY KEY,
    timestamp_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    band TEXT NOT NULL,
    center_hz REAL NOT NULL,
    bandwidth_hz REAL,
    peak_db REAL,
    floor_db REAL,
    snr_db REAL,
    score REAL,
    classification TEXT,
    observations INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sdr_ev_time ON sdr_events(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_sdr_ev_band ON sdr_events(band, center_hz);

CREATE TABLE IF NOT EXISTS sdr_sweeps (
    timestamp_utc TEXT NOT NULL,
    band TEXT NOT NULL,
    floor_db REAL,
    peak_db REAL,
    peak_hz REAL,
    active_bins INTEGER,
    bins INTEGER,
    PRIMARY KEY (timestamp_utc, band)
);

CREATE TABLE IF NOT EXISTS pc_history (
    timestamp_utc TEXT PRIMARY KEY,
    cpu REAL, memory REAL, disk REAL,
    net_rx_bps REAL, net_tx_bps REAL,
    temperature REAL, processes INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PanelDB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            # Stellarium reports 99 for "no magnitude"; never store it as a value.
            self._conn.execute("UPDATE phenomena SET vmag = NULL WHERE vmag >= 50")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def query(self, sql: str, args: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, tuple(args)).fetchall()]

    def one(self, sql: str, args: Iterable[Any] = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(args)).fetchone()
            return dict(row) if row else None

    def scalar(self, sql: str, args: Iterable[Any] = ()):
        with self._lock:
            row = self._conn.execute(sql, tuple(args)).fetchone()
            return row[0] if row else None

    def execute(self, sql: str, args: Iterable[Any] = ()) -> int:
        with self._lock:
            cursor = self._conn.execute(sql, tuple(args))
            self._conn.commit()
            return cursor.lastrowid

    def transaction(self):
        """Context manager yielding the raw connection inside one transaction."""
        db = self

        class _Tx:
            def __enter__(self_inner):
                db._lock.acquire()
                return db._conn

            def __exit__(self_inner, exc_type, exc, tb):
                try:
                    if exc_type:
                        db._conn.rollback()
                    else:
                        db._conn.commit()
                finally:
                    db._lock.release()
                return False

        return _Tx()

    def kv_get(self, key: str, default: str | None = None) -> str | None:
        value = self.scalar("SELECT value FROM kv WHERE key = ?", (key,))
        return default if value is None else value

    def kv_set(self, key: str, value: Any) -> None:
        self.execute("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (key, str(value)))

    # -- phenomena helpers -------------------------------------------------
    @staticmethod
    def upsert_phenomenon(conn: sqlite3.Connection, *, key: str, name: str, category: str, source: str,
                          catalog: str | None = None, ra: float | None = None, dec: float | None = None,
                          vmag: float | None = None, constellation: str | None = None,
                          description: str | None = None, info: dict | None = None,
                          approximate: bool = False) -> int:
        row = conn.execute("SELECT id, category, source FROM phenomena WHERE key = ?", (key,)).fetchone()
        if row is None:
            cursor = conn.execute(
                "INSERT INTO phenomena(key, name, category, catalog, source, ra_j2000, dec_j2000, vmag, "
                "constellation, description, info_json, approximate, created_utc) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (key, name, category, catalog, source, ra, dec, vmag, constellation, description,
                 json.dumps(info) if info else None, int(approximate), utc_now()),
            )
            return cursor.lastrowid
        # Never let a vaguer source overwrite a more specific category/catalog.
        conn.execute(
            "UPDATE phenomena SET catalog = COALESCE(catalog, ?), ra_j2000 = COALESCE(?, ra_j2000), "
            "dec_j2000 = COALESCE(?, dec_j2000), vmag = COALESCE(?, vmag), "
            "constellation = COALESCE(?, constellation), description = COALESCE(description, ?), "
            "info_json = COALESCE(?, info_json) WHERE id = ?",
            (catalog, ra, dec, vmag, constellation, description, json.dumps(info) if info else None, row["id"]),
        )
        return row["id"]

    @staticmethod
    def seen_since(conn: sqlite3.Connection, phenomenon_id: int, since_utc: str, source: str) -> bool:
        return conn.execute("SELECT 1 FROM sightings WHERE phenomenon_id = ? AND source = ? AND observed_utc >= ? LIMIT 1",
                            (phenomenon_id, source, since_utc)).fetchone() is not None

    @staticmethod
    def add_sighting(conn: sqlite3.Connection, phenomenon_id: int, observed_utc: str, source: str,
                     source_ref: str, detail: dict | None = None) -> bool:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO sightings(phenomenon_id, observed_utc, source, source_ref, detail_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (phenomenon_id, observed_utc, source, source_ref, json.dumps(detail) if detail else None),
        )
        if cursor.rowcount:
            conn.execute(
                "UPDATE phenomena SET sightings = sightings + 1, "
                "first_seen_utc = CASE WHEN first_seen_utc IS NULL OR first_seen_utc > ? THEN ? ELSE first_seen_utc END, "
                "last_seen_utc = CASE WHEN last_seen_utc IS NULL OR last_seen_utc < ? THEN ? ELSE last_seen_utc END "
                "WHERE id = ?",
                (observed_utc, observed_utc, observed_utc, observed_utc, phenomenon_id),
            )
            return True
        return False
