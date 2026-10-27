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
# Version fingerprint (2026-10-27): every apply stamps
#   /* == PIVOTAI-THEME-V2:VER=<sha256(css)[0:16]> == */
# into the managed block. -Check compares that stamp against the repo file, so
# it detects "stale theme" and not merely "theme missing". Before this, the
# container could sit on an old build indefinitely and every probe still said OK
# (the 2026-10-09 blue build survived 18 days).
#
# -Check also counts: every stylesheet that carries a managed block must carry
# the current VER. "Any file matches" would call a partial drift healthy - which
# it did, once, when one of five bundles was edited by hand.
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
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest progress bars pollute scheduled-task logs
$themeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$css      = Join-Path $themeDir 'pivot-theme-v2.css'
$js       = Join-Path $themeDir 'pivot-theme-v2.js'
$applier  = Join-Path $themeDir 'pivot-apply.js'
$face     = Join-Path $themeDir 'pivot-face.jpg'
$FACE_DEST = '/app/public/_spa/pivot-face.jpg'

# docker CLI is not on PATH on this host (Docker Desktop installs per-user), so
# resolve it explicitly instead of assuming `docker` works.
function Resolve-Docker {
  if ($env:PIVOT_DOCKER -and (Test-Path $env:PIVOT_DOCKER)) { return $env:PIVOT_DOCKER }
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @(
    # Per-user Docker Desktop install (this host: 4.89.0 lives here, NOT in Program Files)
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\docker.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\bin\docker.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\resources\bin\docker.exe'),
    'D:\Docker\Docker\resources\bin\docker.exe',
    'D:\Program Files\Docker\Docker\resources\bin\docker.exe',
    'D:\DockerDesktop\resources\bin\docker.exe',
    'C:\ProgramData\DockerDesktop\version-bin\docker.exe'
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function ConvertTo-Count($raw) {
  $t = ($raw | Out-String).Trim()
  if ($t -match '^\d+$') { return [int]$t }
  return -1
}

# Three small exec calls instead of one compound sh script: PowerShell 5.1 eats
# embedded double quotes when handing a string to a native exe, which turns a
# clever one-liner into a sh syntax error. Keep every sh fragment single-quoted.
function Get-ThemeProbe([string]$Expected) {
  $blocksSh  = "find /app/public -name '*.css' -exec grep -l 'PIVOTAI-THEME-V2:START' {} + | wc -l"
  $stampedSh = "find /app/public -name '*.css' -exec grep -l 'PIVOTAI-THEME-V2:VER=$Expected' {} + | wc -l"
  $faceSh    = "test -f $FACE_DEST && echo FACE-OK"

  $blocks  = ConvertTo-Count (& $Docker exec lobechat sh -c $blocksSh  2>$null)
  $stamped = ConvertTo-Count (& $Docker exec lobechat sh -c $stampedSh 2>$null)
  $hasFace = ((& $Docker exec lobechat sh -c $faceSh 2>$null | Out-String) -match 'FACE-OK')

  $ok = ($blocks -gt 0) -and ($blocks -eq $stamped) -and $hasFace
  return [pscustomobject]@{ Ok = $ok; Blocks = $blocks; Stamped = $stamped; Face = $hasFace }
}

$Docker = Resolve-Docker
if (-not $Docker) {
  Write-Host "[pivot] ERROR: docker CLI not found. Set PIVOT_DOCKER to the full path of docker.exe." -ForegroundColor Red
  exit 2
}

foreach ($f in @($css, $js, $applier)) { if (-not (Test-Path $f)) { Write-Host "[pivot] ERROR: missing file: $f" -ForegroundColor Red; exit 2 } }
if ((-not $Remove) -and (-not (Test-Path $face))) { Write-Host "[pivot] ERROR: missing face image: $face" -ForegroundColor Red; exit 2 }

$Version = (Get-FileHash -Path $css -Algorithm SHA256).Hash.Substring(0, 16).ToLower()

if ($Check) {
  & $Docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "[pivot] cannot probe: docker daemon unreachable" -ForegroundColor Yellow; exit 2 }

  $p = Get-ThemeProbe $Version
  $detail = "blocks=$($p.Blocks) stamped=$($p.Stamped) face=$($p.Face)"
  if ($p.Ok) {
    Write-Host "[pivot] up to date (version $Version) $detail"
    exit 0
  }
  if ($p.Blocks -le 0) {
    Write-Host "[pivot] MISSING: no managed block in container ($detail, expected version $Version)" -ForegroundColor Yellow
  } else {
    Write-Host "[pivot] STALE: $detail (expected version $Version)" -ForegroundColor Yellow
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
