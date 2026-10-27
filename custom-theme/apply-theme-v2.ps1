# =============================================================================
# apply-theme-v2.ps1 - PivotAI Theme Applier for LobeHub 2.x (repo-side copy)
# Injects custom-theme/pivot-theme-v2.css/.js into the running lobechat
# container (SPA stylesheets + shared vendor runtime), ships the AI face mat
# image, idempotently.
#
# NOTE: the static file server snapshots its file list at container BOOT. New
# files (like the face mat) only start serving after a container restart, so
# after a container RECREATION always run:  apply-theme-v2.ps1 -Restart
#
# Version fingerprint (added 2026-10-27): every apply stamps
#   /* == PIVOTAI-THEME-V2:VER=<sha256(css)[0:16]> == */
# into the managed block. -Check compares that stamp against the repo file, so
# it detects "stale theme" and not merely "theme missing". Before this, the
# container could sit on an old build indefinitely and every probe still said OK
# (the 2026-10-09 blue build survived 18 days).
#
# Exit codes for -Check:  0 = up to date | 1 = missing or stale | 2 = cannot probe
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1            # apply/update
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Restart   # apply + restart container
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Check     # probe (0=ok 1=stale 2=cannot)
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Remove    # uninstall
# =============================================================================
param([switch]$Remove, [switch]$Check, [switch]$Restart)

$ErrorActionPreference = 'Stop'
$themeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$css      = Join-Path $themeDir 'pivot-theme-v2.css'
$js       = Join-Path $themeDir 'pivot-theme-v2.js'
$applier  = Join-Path $themeDir 'pivot-apply.js'
$face     = Join-Path $themeDir 'pivot-face.jpg'
$FACE_DEST = '/app/public/_spa/pivot-face.jpg'

# docker CLI is not on PATH on this host (Docker Desktop moved / wsl.exe is
# blacklisted), so resolve it explicitly instead of assuming `docker` works.
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

$Docker = Resolve-Docker
if (-not $Docker) {
  Write-Host "[pivot] ERROR: docker CLI not found. Set PIVOT_DOCKER to the full path of docker.exe." -ForegroundColor Red
  exit 2
}

foreach ($f in @($css, $js, $applier)) { if (-not (Test-Path $f)) { Write-Host "[pivot] ERROR: missing file: $f" -ForegroundColor Red; exit 2 } }
if ((-not $Remove) -and (-not (Test-Path $face))) { Write-Host "[pivot] ERROR: missing face image: $face" -ForegroundColor Red; exit 2 }

$Version = (Get-FileHash -Path $css -Algorithm SHA256).Hash.Substring(0, 16).ToLower()

function Test-ThemeInPlace {
  $r = & $Docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:VER=$Version' /app/public/_spa/assets/*.css && test -f $FACE_DEST && echo PROBE-OK" 2>$null
  return (($r | Out-String) -match 'PROBE-OK')
}

if ($Check) {
  $r = & $Docker info 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Host "[pivot] cannot probe: docker daemon unreachable" -ForegroundColor Yellow; exit 2 }
  if (Test-ThemeInPlace) {
    Write-Host "[pivot] up to date (version $Version)"
    exit 0
  }
  $present = & $Docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:START' /app/public/_spa/assets/*.css && echo HAS-BLOCK" 2>$null
  if (($present | Out-String) -match 'HAS-BLOCK') {
    Write-Host "[pivot] STALE: block present but not version $Version" -ForegroundColor Yellow
  } else {
    Write-Host "[pivot] MISSING: no managed block in container" -ForegroundColor Yellow
  }
  exit 1
}

function Wait-Up {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri 'http://localhost:3210/' -Method Head -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -ge 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

Write-Host "[pivot] copying theme files into lobechat container (version $Version)..."
& $Docker cp $css lobechat:/tmp/pivot-theme-v2.css | Out-Null
& $Docker cp $js lobechat:/tmp/pivot-theme-v2.js | Out-Null
& $Docker cp $applier lobechat:/tmp/pivot-apply.js | Out-Null
if (-not $Remove) { & $Docker cp $face "lobechat:$FACE_DEST" | Out-Null }

Write-Host "[pivot] applying..."
if ($Remove) {
  & $Docker exec lobechat node /tmp/pivot-apply.js --remove
  & $Docker exec lobechat rm -f $FACE_DEST
} else {
  & $Docker exec -e "PIVOT_VERSION=$Version" lobechat node /tmp/pivot-apply.js
}

if ($Restart) {
  Write-Host "[pivot] restarting lobechat (static file list refresh)..."
  & $Docker restart lobechat | Out-Null
  if (Wait-Up) { Write-Host "[pivot] container back up" } else { Write-Host "[pivot] WARN: container did not come back within 80s" }
}

Write-Host "[pivot] done. Hard-refresh the browser (Ctrl+Shift+R)."
