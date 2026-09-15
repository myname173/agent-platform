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
# Usage:
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1            # apply/update
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Restart   # apply + restart container
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Check     # probe (exit 0=applied 1=missing)
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

if ($Check) {
  $r = docker exec lobechat sh -c "grep -q 'PIVOTAI-THEME-V2:START' /app/public/_spa/assets/*.css && test -f $FACE_DEST && echo PROBE-OK" 2>$null
  if (($r | Out-String) -match 'PROBE-OK') { exit 0 } else { exit 1 }
}

foreach ($f in @($css, $js, $applier)) { if (-not (Test-Path $f)) { Write-Error "missing file: $f"; exit 1 } }
if ((-not $Remove) -and (-not (Test-Path $face))) { Write-Error "missing face image: $face"; exit 1 }

Write-Host "[pivot] copying theme files into lobechat container..."
docker cp $css lobechat:/tmp/pivot-theme-v2.css | Out-Null
docker cp $js lobechat:/tmp/pivot-theme-v2.js | Out-Null
docker cp $applier lobechat:/tmp/pivot-apply.js | Out-Null
if (-not $Remove) { docker cp $face "lobechat:$FACE_DEST" | Out-Null }

Write-Host "[pivot] applying..."
if ($Remove) {
  docker exec lobechat node /tmp/pivot-apply.js --remove
  docker exec lobechat rm -f $FACE_DEST
} else {
  docker exec lobechat node /tmp/pivot-apply.js
}

if ($Restart) {
  Write-Host "[pivot] restarting lobechat (static file list refresh)..."
  docker restart lobechat | Out-Null
  if (Wait-Up) { Write-Host "[pivot] container back up" } else { Write-Host "[pivot] WARN: container did not come back within 80s" }
}

Write-Host "[pivot] done. Hard-refresh the browser (Ctrl+Shift+R)."
