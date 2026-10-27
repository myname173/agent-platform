# =============================================================================
# theme-keeper.ps1 - PivotAI theme watchdog for LobeHub 2.x
# If a container recreation wiped the injected theme, re-apply it automatically
# (apply + container restart, because new static files need a boot to serve).
# Designed for a Windows Scheduled Task (every N minutes); fast-path exits when
# the theme is already in place. Logs only re-applies / errors.
#
# Why the docker check comes first: when the daemon is down the old probe simply
# failed, which looked identical to "the theme was wiped". The watchdog then ran
# a full apply + restart on every 5-minute tick - including an 80s wait for a
# container that could never come back - and logged the failure as "healed".
# An unreachable daemon is now a no-op, logged at most once per 30 minutes.
#
# Version fingerprint (2026-10-27): the probe used to check only that the
# managed block EXISTED. A stale block therefore looked healthy forever - the
# container ran a pre-2026-10-09 blue build for 18 days while every tick said
# OK. The probe now compares the block's VER= stamp against the sha256 of the
# repo CSS, so a version drift triggers a re-apply. See custom-theme/legacy/.
#
# Single source of truth: this script owns NO probe logic. It shells out to
# `apply-theme-v2.ps1 -Check` and reads the exit code
#   0 = up to date | 1 = missing or stale | 2 = cannot probe
# so the two can never drift apart (they did: the keeper once had its own
# presence-only grep while -Check had a stricter one).
# =============================================================================
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'theme-keeper.log'
$stateFile = Join-Path $dir '.theme-keeper-misses'
$css = Join-Path $dir 'pivot-theme-v2.css'
$apply = Join-Path $dir 'apply-theme-v2.ps1'

function Write-KeeperLog([string]$line) {
  Add-Content -Path $log -Encoding UTF8 -Value $line
  $item = Get-Item $log -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.Length -gt 1048576) {
    $tail = Get-Content $log -Tail 500
    Set-Content -Path $log -Encoding UTF8 -Value $tail
  }
}

function Note-Skip([string]$reason) {
  $misses = 0
  if (Test-Path $stateFile) {
    $raw = Get-Content $stateFile -Raw
    if ($raw) { $misses = [int]$raw.Trim() }
  }
  $misses = $misses + 1
  Set-Content -Path $stateFile -Value $misses
  # Every tick is 5 minutes, so log once per 30 minutes (plus the first miss).
  if ($misses -eq 1 -or ($misses % 6) -eq 0) {
    Write-KeeperLog ("[{0}] skipped: {1} ({2} consecutive ticks)" -f (Get-Date -Format s), $reason, $misses)
  }
  exit 0
}

try {
  if (-not (Test-Path $css)) { Note-Skip "theme source missing: $css" }
  if (-not (Test-Path $apply)) { Note-Skip "applier missing: $apply" }

  # 1) Ask the applier - it owns the probe (and the docker lookup).
  $checkOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $apply -Check 2>&1 | Out-String)
  $checkCode = $LASTEXITCODE
  $checkFlat = ($checkOut -replace '\s+', ' ').Trim()

  if ($checkCode -eq 0) { exit 0 }                       # healthy, nothing to do
  if ($checkCode -eq 2) { Note-Skip "cannot probe: $checkFlat" }

  if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

  # 2) Re-apply. Label honestly: a failed apply must not be recorded as healed.
  $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File $apply -Restart 2>&1 | Out-String)
  $flat = ($out -replace '\s+', ' ').Trim()
  if ($flat -match 'did not come back|failed to connect|error|ERROR') {
    $label = 'FAILED'
  } else {
    $label = 'healed'
  }
  Write-KeeperLog ("[{0}] {1} - {2} :: {3}" -f (Get-Date -Format s), $label, $checkFlat, $flat)
} catch {
  Write-KeeperLog ("[{0}] error: {1}" -f (Get-Date -Format s), $_.Exception.Message)
}
