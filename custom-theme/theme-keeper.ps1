# =============================================================================
# theme-keeper.ps1 - PivotAI theme watchdog for LobeHub 2.x
# If a container recreation wiped the injected theme, re-apply it automatically
# (apply + container restart, because new static files need a boot to serve).
# Designed for a Windows Scheduled Task (every N minutes); fast-path exits when
# the theme is already in place. Logs only re-applies / errors.
# =============================================================================
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'theme-keeper.log'

try {
  $probe = docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:START' /app/public/_spa/assets/*.css && test -f /app/public/_spa/pivot-face.jpg && echo KEEPER-OK" 2>$null
  if (($probe | Out-String) -match 'KEEPER-OK') { exit 0 }

  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'apply-theme-v2.ps1') -Restart 2>&1 | Out-String
  $line = "[{0}] healed: {1}" -f (Get-Date -Format s), (($out -replace "\s+", ' ').Trim())
  Add-Content -Path $log -Encoding UTF8 -Value $line
} catch {
  $line = "[{0}] error: {1}" -f (Get-Date -Format s), $_.Exception.Message
  Add-Content -Path $log -Encoding UTF8 -Value $line
}
