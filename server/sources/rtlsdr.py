"""RTL-SDR band monitor built on rtl_power (from the rtl-sdr / librtlsdr tools).

Two modes (config "rtlsdr"):

* "rtl_power" - the panel runs `rtl_power -1` once per configured band every
  interval_seconds. Each run is a single sweep, so the dongle is free again in
  between and other SDR software can use it; if the device is busy the sweep is
  simply skipped and reported as such.
* "csv"       - you run rtl_power yourself (e.g. `rtl_power -f 88M:108M:100k -i 10 sweep.csv`)
  and the panel tails that CSV file (csv_path).

For every sweep the panel stores the band's noise floor and peak, keeps the
latest spectrum in memory for the SIGNALS screen, and logs an "event" for each
cluster of bins standing event_threshold_db above the floor. A signal already
logged at the same frequency in the last 6 hours is updated, not duplicated.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import shutil
import statistics
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..db import PanelDB, utc_now

LOG = logging.getLogger("panel.rtlsdr")
REPEAT_WINDOW_HOURS = 6


def parse_hz(text: str) -> float:
    text = text.strip().lower()
    scale = 1.0
    if text and text[-1] in "kmg":
        scale = {"k": 1e3, "m": 1e6, "g": 1e9}[text[-1]]
        text = text[:-1]
    return float(text) * scale


def band_limits(spec: str) -> tuple[float, float]:
    low, high = spec.split(":")[:2]
    return parse_hz(low), parse_hz(high)


def classify(bandwidth_hz: float, step_hz: float) -> str:
    if bandwidth_hz <= max(3 * step_hz, 5_000):
        return "narrowband carrier"
    if bandwidth_hz <= 30_000:
        return "narrowband voice / data"
    if bandwidth_hz <= 300_000:
        return "wideband (broadcast / FM)"
    return "very wide / noise"


class RtlSdrSource:
    def __init__(self, config: dict, db: PanelDB):
        self.config = config
        self.db = db
        self.spectra: dict[str, dict[str, Any]] = {}     # band -> latest {t, freqs, powers, floor}
        self.status: dict[str, Any] = {"enabled": self.settings.get("enabled", False), "available": False,
                                       "mode": self.settings.get("mode"), "error": None, "last_sweep": None}
        self._csv_offset = 0
        self.latest_event: dict | None = None

    @property
    def settings(self) -> dict:
        return self.config.get("rtlsdr") or {}

    def bands(self) -> list[dict]:
        bands = []
        for band in self.settings.get("bands", []):
            try:
                low, high = band_limits(band["range"])
            except (KeyError, ValueError):
                LOG.warning("Ignoring malformed rtlsdr band %r", band)
                continue
            bands.append({"name": band.get("name") or band["range"], "range": band["range"], "low": low, "high": high})
        return bands

    # -- main loop -------------------------------------------------------------
    async def run_forever(self) -> None:
        if not self.settings.get("enabled"):
            self.status.update(enabled=False, available=False, error="disabled in config (rtlsdr.enabled)")
            return
        await asyncio.to_thread(self._prune)
        mode = self.settings.get("mode", "rtl_power")
        while True:
            try:
                if mode == "csv":
                    await self._read_csv()
                    await asyncio.sleep(15)
                    continue
                await self._sweep_all()
            except Exception as error:
                LOG.exception("rtl-sdr cycle failed")
                self.status.update(available=False, error=str(error)[:200])
            await asyncio.sleep(max(30, float(self.settings.get("interval_seconds", 300))))

    def _binary(self) -> str | None:
        configured = str(self.settings.get("rtl_power_path") or "rtl_power")
        if os.path.isfile(configured):
            return configured
        return shutil.which(configured)

    async def _sweep_all(self) -> None:
        binary = self._binary()
        if not binary:
            self.status.update(available=False, error="rtl_power not found: install the rtl-sdr tools or set rtlsdr.rtl_power_path")
            return
        errors = []
        for band in self.bands():
            rows, error = await self._run_rtl_power(binary, band["range"])
            if error:
                errors.append(f"{band['name']}: {error}")
                continue
            await asyncio.to_thread(self._ingest_rows, rows, band)
        self.status.update(available=len(errors) < len(self.bands()), error="; ".join(errors)[:300] or None)

    async def _run_rtl_power(self, binary: str, spec: str) -> tuple[list[list[str]], str | None]:
        s = self.settings
        args = [binary, "-f", spec, "-i", str(int(s.get("integration_seconds", 5))), "-1",
                "-d", str(int(s.get("device_index", 0)))]
        if str(s.get("gain", "")).strip():
            args += ["-g", str(s["gain"])]
        if int(s.get("ppm", 0) or 0):
            args += ["-p", str(int(s["ppm"]))]
        flags = getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                           stderr=asyncio.subprocess.PIPE, creationflags=flags)
        except OSError as error:
            return [], f"cannot start rtl_power ({error})"
        timeout = 60 + 4 * int(s.get("integration_seconds", 5))
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            return [], "rtl_power timed out"
        if process.returncode != 0 or not stdout.strip():
            message = stderr.decode("utf-8", "replace").strip().splitlines()
            hint = next((line for line in message if "usb_claim_interface" in line or "No supported devices" in line
                         or "Failed to open" in line), message[-1] if message else f"exit code {process.returncode}")
            if "usb_claim_interface" in hint or "Failed to open" in hint:
                hint = "device busy (another SDR program is using it)"
            return [], hint[:120]
        return list(csv.reader(io.StringIO(stdout.decode("utf-8", "replace")))), None

    async def _read_csv(self) -> None:
        path = Path(str(self.settings.get("csv_path") or ""))
        if not path.is_file():
            self.status.update(available=False, error="csv_path not set or file not found")
            return

        def read() -> list[list[str]]:
            size = path.stat().st_size
            if size < self._csv_offset:      # file was rotated / restarted
                self._csv_offset = 0
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(self._csv_offset)
                data = handle.read()
                # only consume complete lines
                cut = data.rfind("\n") + 1
                self._csv_offset += len(data[:cut].encode("utf-8"))
            return list(csv.reader(io.StringIO(data[:cut])))

        rows = await asyncio.to_thread(read)
        if rows:
            await asyncio.to_thread(self._ingest_rows, rows, None)
        self.status.update(available=True, error=None)

    # -- processing ----------------------------------------------------------
    def _ingest_rows(self, rows: list[list[str]], band: dict | None) -> None:
        """rtl_power CSV: date, time, hz_low, hz_high, hz_step, samples, dB, dB, ..."""
        sweeps: dict[tuple[str, str], list[tuple[float, float]]] = {}
        steps: dict[tuple[str, str], float] = {}
        for row in rows:
            if len(row) < 7:
                continue
            try:
                stamp = f"{row[0].strip()} {row[1].strip()}"
                low, step = float(row[2]), float(row[4])
                powers = [float(v) for v in row[6:] if v.strip() and v.strip().lower() != "nan"]
            except ValueError:
                continue
            name = band["name"] if band else self._band_for(low)
            key = (stamp if band is None else "run", name)
            points = sweeps.setdefault(key, [])
            points.extend((low + (i + 0.5) * step, p) for i, p in enumerate(powers))
            steps[key] = step
        for (stamp, name), points in sweeps.items():
            if len(points) >= 8:
                self._analyse(name, sorted(points), steps[(stamp, name)])

    def _band_for(self, hz: float) -> str:
        for band in self.bands():
            if band["low"] <= hz <= band["high"]:
                return band["name"]
        return f"{hz / 1e6:.0f} MHz"

    def _analyse(self, name: str, points: list[tuple[float, float]], step: float) -> None:
        now = utc_now()
        freqs = [f for f, _ in points]
        powers = [p for _, p in points]
        floor = statistics.median(powers)
        threshold = floor + float(self.settings.get("event_threshold_db", 12))
        peak_index = max(range(len(powers)), key=powers.__getitem__)
        active = sum(1 for p in powers if p >= threshold)
        # keep a downsampled copy of the latest spectrum (max 600 points) for the UI
        stride = max(1, len(points) // 600)
        self.spectra[name] = {"t": now, "floor": floor, "step_hz": step,
                              "freqs": freqs[::stride], "powers": [max(powers[i:i + stride]) for i in range(0, len(powers), stride)]}
        # contiguous clusters above threshold -> events
        clusters, current = [], []
        for f, p in points:
            if p >= threshold:
                current.append((f, p))
            elif current:
                clusters.append(current); current = []
        if current:
            clusters.append(current)
        merge_hz = float(self.settings.get("event_merge_khz", 50)) * 1e3
        since = (datetime.now(timezone.utc) - timedelta(hours=REPEAT_WINDOW_HOURS)).isoformat()
        with self.db.transaction() as conn:
            conn.execute("INSERT OR REPLACE INTO sdr_sweeps(timestamp_utc, band, floor_db, peak_db, peak_hz, active_bins, bins) "
                         "VALUES (?, ?, ?, ?, ?, ?, ?)", (now, name, floor, powers[peak_index], freqs[peak_index], active, len(points)))
            for cluster in clusters[:50]:
                f_peak, p_peak = max(cluster, key=lambda item: item[1])
                bandwidth = (cluster[-1][0] - cluster[0][0]) + step
                snr = p_peak - floor
                score = round(min(100.0, snr * 2.5 + min(20.0, len(cluster))), 1)
                existing = conn.execute(
                    "SELECT id FROM sdr_events WHERE band = ? AND ABS(center_hz - ?) <= ? AND last_seen_utc >= ? "
                    "ORDER BY last_seen_utc DESC LIMIT 1", (name, f_peak, merge_hz, since)).fetchone()
                if existing:
                    conn.execute("UPDATE sdr_events SET last_seen_utc = ?, observations = observations + 1, "
                                 "snr_db = MAX(snr_db, ?), peak_db = MAX(peak_db, ?), score = MAX(score, ?) WHERE id = ?",
                                 (now, snr, p_peak, score, existing["id"]))
                    continue
                cursor = conn.execute(
                    "INSERT INTO sdr_events(timestamp_utc, last_seen_utc, band, center_hz, bandwidth_hz, peak_db, floor_db, "
                    "snr_db, score, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (now, now, name, f_peak, bandwidth, p_peak, floor, snr, score, classify(bandwidth, step)))
                self.latest_event = {"id": cursor.lastrowid, "band": name, "center_hz": f_peak, "score": score}
        self.status.update(last_sweep=now)

    def _prune(self) -> None:
        days = float(self.settings.get("retention_days", 30))
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        self.db.execute("DELETE FROM sdr_sweeps WHERE timestamp_utc < ?", (cutoff,))
        self.db.execute("DELETE FROM sdr_events WHERE last_seen_utc < ?", (cutoff,))

    # -- API views -------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {**self.status, "bands": [{"name": b["name"], "range": b["range"]} for b in self.bands()],
                "spectra_bands": sorted(self.spectra)}

    def last_sweep_age(self) -> float | None:
        last = self.status.get("last_sweep")
        return None if not last else time.time() - datetime.fromisoformat(last).timestamp()
