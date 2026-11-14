#!/usr/bin/env bash
# Starts the panel in this terminal (Ctrl+C to stop). Run scripts/install.sh once first.
cd "$(dirname "$0")"
if [[ -x .venv/bin/python ]]; then
  exec .venv/bin/python -m server
fi
echo "The virtual environment is missing. Run: ./scripts/install.sh"
exit 1
