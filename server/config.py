"""Configuration.

config/panel.config.json   defaults, tracked by git; do not put anything personal here
config/panel.local.json    your overrides and the control PIN; ignored by git, created on first run

Environment overrides (handy for Docker or a second instance):
  PANEL_DATA, PANEL_LOGS, PANEL_LOCAL_CONFIG, PANEL_PORT, PANEL_HOST, STELLARIUM_URL, NASA_API_KEY
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
DATA_DIR = Path(os.environ.get("PANEL_DATA") or ROOT / "data")
LOG_DIR = Path(os.environ.get("PANEL_LOGS") or ROOT / "logs")
STATIC_DIR = ROOT / "static"
DEFAULTS_PATH = CONFIG_DIR / "panel.config.json"
LOCAL_PATH = Path(os.environ.get("PANEL_LOCAL_CONFIG") or CONFIG_DIR / "panel.local.json")

LOG = logging.getLogger("panel")


def _first_run_local() -> None:
    """Create panel.local.json with a random control PIN the first time the panel starts."""
    if LOCAL_PATH.exists():
        return
    pin = f"{secrets.randbelow(10**6):06d}"
    LOCAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_PATH.write_text(json.dumps({"control_pin": pin}, indent=2) + "\n", encoding="utf-8")
    print("=" * 64)
    print(f" First run: created {LOCAL_PATH.name} with control PIN {pin}")
    print(" (change or remove it there; an empty PIN disables Stellarium control)")
    print("=" * 64)


def load_config() -> dict[str, Any]:
    config = json.loads(DEFAULTS_PATH.read_text(encoding="utf-8"))
    _first_run_local()
    if LOCAL_PATH.exists():
        local = json.loads(LOCAL_PATH.read_text(encoding="utf-8-sig"))
        for key, value in local.items():
            if isinstance(value, dict) and isinstance(config.get(key), dict):
                config[key] = {**config[key], **value}
            else:
                config[key] = value
    env = {"PANEL_PORT": ("listen_port", int), "PANEL_HOST": ("listen_host", str),
           "STELLARIUM_URL": ("stellarium_url", str), "NASA_API_KEY": ("nasa_api_key", str)}
    for name, (key, cast) in env.items():
        if os.environ.get(name):
            config[key] = cast(os.environ[name])
    config.setdefault("control_pin", "")
    return _expand(config)


def _expand(value):
    """Expand ~ and environment variables in paths so config files stay machine-neutral."""
    if isinstance(value, str):
        return os.path.expanduser(os.path.expandvars(value)) if ("%" in value or "$" in value or value.startswith("~")) else value
    if isinstance(value, list):
        return [_expand(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand(item) for key, item in value.items()}
    return value


def setup_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("panel")
    if not logger.handlers:
        handler = RotatingFileHandler(LOG_DIR / "panel.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
        logger.addHandler(handler)
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(console)
        logger.setLevel(logging.INFO)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    return logger
