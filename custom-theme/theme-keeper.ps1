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
# =============================================================================
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'theme-keeper.log'
$stateFile = Join-Path $dir '.theme-keeper-misses'

function Write-KeeperLog([string]$line) {
  Add-Content -Path $log -Encoding UTF8 -Value $line
  $item = Get-Item $log -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.Length -gt 1048576) {
    $tail = Get-Content $log -Tail 500
    Set-Content -Path $log -Encoding UTF8 -Value $tail
  }
}

try {
  # 1) Daemon unreachable -> nothing can be healed. Skip without touching docker.
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $misses = 0
    if (Test-Path $stateFile) {
      $raw = Get-Content $stateFile -Raw
      if ($raw) { $misses = [int]$raw.Trim() }
    }
    $misses = $misses + 1
    Set-Content -Path $stateFile -Value $misses
    # Every tick is 5 minutes, so log once per 30 minutes (plus the first miss).
    if ($misses -eq 1 -or ($misses % 6) -eq 0) {
      Write-KeeperLog ("[{0}] skipped: docker daemon unreachable ({1} consecutive ticks)" -f (Get-Date -Format s), $misses)
    }
    exit 0
  }
  if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

  # 2) Fast path: theme already in place.
  $probe = docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:START' /app/public/_spa/assets/*.css && test -f /app/public/_spa/pivot-face.jpg && echo KEEPER-OK" 2>$null
  if (($probe | Out-String) -match 'KEEPER-OK') { exit 0 }

  # 3) Re-apply. Label honestly: a failed apply must not be recorded as healed.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'apply-theme-v2.ps1') -Restart 2>&1 | Out-String
  $flat = ($out -replace "\s+", ' ').Trim()
  if ($flat -match 'did not come back|failed to connect|error') {
    $label = 'FAILED'
  } else {
    $label = 'healed'
  }
  Write-KeeperLog ("[{0}] {1}: {2}" -f (Get-Date -Format s), $label, $flat)
} catch {
  Write-KeeperLog ("[{0}] error: {1}" -f (Get-Date -Format s), $_.Exception.Message)
}
