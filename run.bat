@echo off
rem Starts the panel in this window (Ctrl+C to stop). Run scripts\install-windows.ps1 once first.
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m server
) else (
  echo The virtual environment is missing. Run:  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  pause
)
