#!/usr/bin/env bash
# Sets up the panel on Linux / macOS: virtual environment + requirements, and
# optionally a systemd *user* service that starts it at login (Linux only).
#
#   ./scripts/install.sh             # install only
#   ./scripts/install.sh --service   # install and enable the systemd user service
#   ./scripts/install.sh --remove    # disable and remove the service
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="stellarium-signal-panel.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Service removed (data and config kept)."
  exit 0
fi

PY="$(command -v python3 || command -v python || true)"
[[ -n "$PY" ]] || { echo "Python 3.10+ is required (e.g. sudo apt install python3 python3-venv)"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo "Python 3.10+ is required"; exit 1; }

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Creating virtual environment in .venv ..."
  "$PY" -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/python" -m pip install --upgrade pip --quiet
"$ROOT/.venv/bin/python" -m pip install -r "$ROOT/requirements.txt" --quiet
echo "Requirements installed."

# first run creates config/panel.local.json with a random control PIN
if [[ ! -f "$ROOT/config/panel.local.json" ]]; then
  (cd "$ROOT" && .venv/bin/python -c 'from server.config import load_config; load_config()')
fi

if [[ "${1:-}" == "--service" ]]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=Stellarium signal panel
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$ROOT/.venv/bin/python -m server
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  echo "Service enabled. To keep it running while logged out: loginctl enable-linger \$USER"
fi

echo
echo "Done."
echo "  Start manually : ./run.sh"
echo "  Open           : http://localhost:8765  (other devices: http://<this machine's LAN address>:8765)"
echo "  Control PIN    : see config/panel.local.json"
