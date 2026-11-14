<#
.SYNOPSIS
  Sets up the panel on Windows: creates a Python virtual environment, installs the
  requirements and (optionally) starts the panel automatically when you log on.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Startup
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Uninstall
#>
param(
    [switch]$Startup,      # also register a logon task that runs the panel in the background
    [switch]$Uninstall,    # remove the logon task (keeps your data and config)
    [switch]$OpenFirewall  # allow other devices on your private network to reach the port (needs admin)
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = "StellariumSignalPanel"
$Venv = Join-Path $Root ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$VenvPythonW = Join-Path $Venv "Scripts\pythonw.exe"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' logon task."
    } else { Write-Host "No '$TaskName' task is registered." }
    Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    return
}

# 1. Python 3.10+
$python = $null
foreach ($candidate in @("py -3", "python", "python3")) {
    $parts = $candidate.Split(" ")
    try {
        $version = & $parts[0] $parts[1..($parts.Length)] -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and [version]$version -ge [version]"3.10") { $python = $parts; break }
    } catch { }
}
if (-not $python) { throw "Python 3.10 or newer was not found. Install it from https://www.python.org/downloads/ (tick 'Add to PATH')." }

# 2. Virtual environment + requirements
if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating virtual environment in .venv ..."
    & $python[0] $python[1..($python.Length)] -m venv $Venv
}
& $VenvPython -m pip install --upgrade pip --quiet
& $VenvPython -m pip install -r (Join-Path $Root "requirements.txt") --quiet
Write-Host "Requirements installed."

# 3. First-run config (creates config\panel.local.json with a random control PIN)
$local = Join-Path $Root "config\panel.local.json"
if (-not (Test-Path $local)) {
    & $VenvPython -c "import sys; sys.path.insert(0, r'$Root'); from server.config import load_config; load_config()"
}
$config = Get-Content $local -Raw | ConvertFrom-Json
$port = 8765
if ($config.PSObject.Properties.Name -contains "listen_port") { $port = [int]$config.listen_port }

# 4. Optional firewall rule (private networks only)
if ($OpenFirewall) {
    if (-not (Get-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $TaskName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null
        Write-Host "Firewall: allowed TCP $port on private networks."
    }
}

# 5. Optional logon task
if ($Startup) {
    $action = New-ScheduledTaskAction -Execute $VenvPythonW -Argument "-m server" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Registered and started the '$TaskName' logon task."
}

Write-Host ""
Write-Host "Done."
Write-Host "  Start manually : .\run.bat"
Write-Host "  Open           : http://localhost:$port  (other devices: http://<this PC's LAN address>:$port)"
Write-Host "  Control PIN    : see config\panel.local.json"
