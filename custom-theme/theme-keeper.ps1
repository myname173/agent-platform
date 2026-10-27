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
# Docker CLI is not on PATH on this host; PIVOT_DOCKER overrides the lookup.
# =============================================================================
$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'theme-keeper.log'
$stateFile = Join-Path $dir '.theme-keeper-misses'
$css = Join-Path $dir 'pivot-theme-v2.css'
$FACE_DEST = '/app/public/_spa/pivot-face.jpg'

function Write-KeeperLog([string]$line) {
  Add-Content -Path $log -Encoding UTF8 -Value $line
  $item = Get-Item $log -ErrorAction SilentlyContinue
  if ($null -ne $item -and $item.Length -gt 1048576) {
    $tail = Get-Content $log -Tail 500
    Set-Content -Path $log -Encoding UTF8 -Value $tail
  }
}

function Resolve-Docker {
  if ($env:PIVOT_DOCKER -and (Test-Path $env:PIVOT_DOCKER)) { return $env:PIVOT_DOCKER }
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\bin\docker.exe'),
    'D:\Docker\Docker\resources\bin\docker.exe',
    'D:\Program Files\Docker\Docker\resources\bin\docker.exe',
    'D:\DockerDesktop\resources\bin\docker.exe'
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Note-Unreachable([string]$reason) {
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
  if (-not (Test-Path $css)) { Note-Unreachable "theme source missing: $css" }

  $Docker = Resolve-Docker
  if (-not $Docker) { Note-Unreachable 'docker CLI not found (set PIVOT_DOCKER)' }

  # 1) Daemon unreachable -> nothing can be healed.
  & $Docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Note-Unreachable 'docker daemon unreachable' }
  if (Test-Path $stateFile) { Remove-Item $stateFile -Force }

  # 2) Fast path: the exact version of the repo CSS is already in the container.
  $ver = (Get-FileHash -Path $css -Algorithm SHA256).Hash.Substring(0, 16).ToLower()
  $probe = & $Docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:VER=$ver' /app/public/_spa/assets/*.css && test -f $FACE_DEST && echo KEEPER-OK" 2>$null
  if (($probe | Out-String) -match 'KEEPER-OK') { exit 0 }

  # Diagnose before healing: missing block vs stale version.
  $found = (& $Docker exec lobechat sh -c "grep -oh 'PIVOTAI-THEME-V2:VER=[0-9a-f]*' /app/public/_spa/assets/*.css | head -1" 2>$null | Out-String).Trim()
  if ($found) {
    $reason = "stale theme: container has $found, repo wants VER=$ver"
  } else {
    $reason = "theme missing in container (expected VER=$ver)"
  }

  # 3) Re-apply. Label honestly: a failed apply must not be recorded as healed.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'apply-theme-v2.ps1') -Restart 2>&1 | Out-String
  $flat = ($out -replace "\s+", ' ').Trim()
  if ($flat -match 'did not come back|failed to connect|error|ERROR') {
    $label = 'FAILED'
  } else {
    $label = 'healed'
  }
  Write-KeeperLog ("[{0}] {1} - {2} :: {3}" -f (Get-Date -Format s), $label, $reason, $flat)
} catch {
  Write-KeeperLog ("[{0}] error: {1}" -f (Get-Date -Format s), $_.Exception.Message)
}
