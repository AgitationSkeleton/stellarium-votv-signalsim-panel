"""PC telemetry for the machine running the panel (Windows, Linux and macOS).

Temperatures come from, in order: a LibreHardwareMonitor / OpenHardwareMonitor
web server (hardware_monitor_url), psutil sensors (Linux), or WMI (Windows)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import socket
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiohttp
import psutil

from .db import PanelDB

LOG = logging.getLogger("panel.system")


TEMPERATURE_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$ohm = Get-CimInstance -Namespace root/OpenHardwareMonitor -ClassName Sensor -Filter "SensorType='Temperature'"
foreach ($s in $ohm) { $out += [pscustomobject]@{ source='ohm'; name=$s.Name; parent=$s.Parent; value=[double]$s.Value } }
if ($out.Count -eq 0) {
  $tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
  foreach ($t in $tz) { $out += [pscustomobject]@{ source='acpi'; name=$t.InstanceName; parent=''; value=[math]::Round(($t.CurrentTemperature / 10.0) - 273.15, 1) } }
}
$out | ConvertTo-Json -Compress
"""


class SystemService:
    def __init__(self, config: dict, db: PanelDB):
        self.config = config
        self.db = db
        self.current: dict[str, Any] = {}
        self.services: dict[str, Any] = {}
        self.temperatures: list[dict[str, Any]] = []
        self._last_net = None
        self._last_disk = None
        self.static = {
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.release()} ({platform.version()})",
            "cpu_name": platform.processor(),
            "cpu_cores": psutil.cpu_count(logical=False),
            "cpu_threads": psutil.cpu_count(logical=True),
            "memory_total": psutil.virtual_memory().total,
            "python": platform.python_version(),
            "boot_time": datetime.fromtimestamp(psutil.boot_time(), timezone.utc).isoformat(),
        }
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)

    # -- fast loop -----------------------------------------------------------
    async def sample_forever(self) -> None:
        tick = 0
        while True:
            try:
                await asyncio.to_thread(self._sample_fast)
                if tick % 5 == 0:
                    await asyncio.to_thread(self._sample_services)
                if tick % 30 == 0:
                    await asyncio.to_thread(self._store_history)
                if tick % 1800 == 0:
                    await asyncio.to_thread(self._prune_history)
            except Exception:
                LOG.exception("system sample failed")
            tick += 1
            await asyncio.sleep(2)

    def _disk_paths(self) -> list[str]:
        configured = self.config.get("disk_paths") or []
        if configured:
            return configured
        if not hasattr(self, "_auto_disks"):
            try:
                parts = [p.mountpoint for p in psutil.disk_partitions(all=False)
                         if p.fstype and "cdrom" not in p.opts and not p.mountpoint.startswith(("/snap", "/boot", "/System"))]
            except Exception:
                parts = []
            self._auto_disks = parts[:4] or [os.path.abspath(os.sep)]
        return self._auto_disks

    def _sample_fast(self) -> None:
        now = time.time()
        memory = psutil.virtual_memory()
        net = psutil.net_io_counters()
        disk_io = psutil.disk_io_counters()
        rx = tx = rd = wr = 0.0
        if self._last_net:
            dt = max(0.1, now - self._last_net[0])
            rx = max(0, net.bytes_recv - self._last_net[1]) / dt
            tx = max(0, net.bytes_sent - self._last_net[2]) / dt
        if self._last_disk and disk_io:
            dt = max(0.1, now - self._last_disk[0])
            rd = max(0, disk_io.read_bytes - self._last_disk[1]) / dt
            wr = max(0, disk_io.write_bytes - self._last_disk[2]) / dt
        self._last_net = (now, net.bytes_recv, net.bytes_sent)
        if disk_io:
            self._last_disk = (now, disk_io.read_bytes, disk_io.write_bytes)
        disks = []
        for path in self._disk_paths():
            try:
                usage = psutil.disk_usage(path)
                disks.append({"path": path, "total": usage.total, "used": usage.used,
                              "free": usage.free, "percent": usage.percent})
            except OSError:
                continue
        frequency = psutil.cpu_freq()
        self.current = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "cpu": psutil.cpu_percent(interval=None),
            "cpu_per_core": psutil.cpu_percent(interval=None, percpu=True),
            "cpu_freq_mhz": round(frequency.current) if frequency else None,
            "memory": {"percent": memory.percent, "used": memory.used, "total": memory.total,
                       "available": memory.available},
            "disks": disks,
            "net": {"rx_bps": rx, "tx_bps": tx, "rx_total": net.bytes_recv, "tx_total": net.bytes_sent},
            "disk_io": {"read_bps": rd, "write_bps": wr},
            "uptime_seconds": max(0, now - psutil.boot_time()),
            "temperature": self.cpu_temperature(),
        }

    def _patterns(self) -> dict[str, list[str]]:
        return {key: [n.lower() for n in names] for key, names in (self.config.get("watch_processes") or {}).items()}

    def _sample_services(self) -> None:
        patterns = self._patterns()
        found = {key: {"running": False, "rss": 0, "cpu": 0.0, "pids": []} for key in patterns}
        process_count = 0
        for process in psutil.process_iter(["name", "memory_info", "pid"]):
            process_count += 1
            name = (process.info.get("name") or "").lower()
            for key, names in patterns.items():
                if name not in names:
                    continue
                entry = found[key]
                entry["running"] = True
                entry["pids"].append(process.info["pid"])
                if process.info.get("memory_info"):
                    entry["rss"] += process.info["memory_info"].rss
        own = psutil.Process(os.getpid())
        found["panel"] = {"running": True, "rss": own.memory_info().rss, "pids": [own.pid]}
        self.services = {"processes": process_count, "services": found}

    def _store_history(self) -> None:
        current = self.current
        if not current:
            return
        disk = current["disks"][0]["percent"] if current.get("disks") else None
        self.db.execute(
            "INSERT OR REPLACE INTO pc_history(timestamp_utc, cpu, memory, disk, net_rx_bps, net_tx_bps, temperature, processes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (current["timestamp"], current["cpu"], current["memory"]["percent"], disk,
             current["net"]["rx_bps"], current["net"]["tx_bps"], current.get("temperature"),
             self.services.get("processes")),
        )

    def _prune_history(self) -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=float(self.config.get("pc_history_retention_days", 14)))
        self.db.execute("DELETE FROM pc_history WHERE timestamp_utc < ?", (cutoff.isoformat(),))

    # -- temperatures ---------------------------------------------------------
    def cpu_temperature(self) -> float | None:
        candidates = [item for item in self.temperatures if isinstance(item.get("value"), (int, float))]
        if not candidates:
            return None
        preferred = [item for item in candidates if "cpu" in f"{item.get('name')} {item.get('parent')}".lower()
                     and "package" in str(item.get("name")).lower()]
        preferred = preferred or [item for item in candidates if "cpu" in f"{item.get('name')} {item.get('parent')}".lower()]
        pool = preferred or candidates
        return round(max(item["value"] for item in pool), 1)

    async def temperature_forever(self) -> None:
        while True:
            try:
                self.temperatures = (await self._read_ohm_http() or await asyncio.to_thread(self._read_psutil)
                                     or await self._read_wmi())
            except Exception as error:
                LOG.debug("temperature read failed: %s", error)
            await asyncio.sleep(float(self.config.get("temperature_poll_seconds", 60)))

    async def _read_ohm_http(self) -> list[dict]:
        url = self.config.get("hardware_monitor_url")
        if not url:
            return []
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as session:
                async with session.get(url) as response:
                    payload = await response.json(content_type=None)
        except Exception:
            return []
        readings: list[dict] = []

        def walk(node, parent=""):
            text = node.get("Text", "")
            value = str(node.get("Value", ""))
            if "°C" in value:
                try:
                    readings.append({"source": "ohm-http", "name": text, "parent": parent,
                                     "value": float(value.replace("°C", "").strip().replace(",", "."))})
                except ValueError:
                    pass
            for child in node.get("Children", []):
                walk(child, text or parent)

        walk(payload)
        return readings

    @staticmethod
    def _read_psutil() -> list[dict]:
        reader = getattr(psutil, "sensors_temperatures", None)
        if not reader:
            return []
        try:
            groups = reader() or {}
        except Exception:
            return []
        readings = []
        for parent, entries in groups.items():
            for entry in entries:
                if entry.current:
                    readings.append({"source": "psutil", "name": entry.label or parent, "parent": parent,
                                     "value": float(entry.current)})
        return readings

    async def _read_wmi(self) -> list[dict]:
        if os.name != "nt":
            return []
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = await asyncio.create_subprocess_exec(
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", TEMPERATURE_SCRIPT,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, creationflags=flags)
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=20)
        except asyncio.TimeoutError:
            process.kill()
            return []
        text = stdout.decode("utf-8", "replace").strip()
        if not text:
            return []
        data = json.loads(text)
        return data if isinstance(data, list) else [data]

    # -- API views -----------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {**self.current, **self.services, "static": self.static, "temperatures": self.temperatures[:24]}

    def history(self, hours: float) -> list[dict]:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        rows = self.db.query("SELECT * FROM pc_history WHERE timestamp_utc >= ? ORDER BY timestamp_utc", (cutoff,))
        step = max(1, len(rows) // 360)
        return rows[::step]
