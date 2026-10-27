# =============================================================================
# [LEGACY - DO NOT USE] apply-theme-v2.ps1, earlier root-level draft
#
# Archived on 2026-10-27. Superseded by ../apply-theme-v2.ps1, which adds the
# AI face mat shipping, -Check (probe), -Restart (static file list refresh) and
# the version fingerprint the watchdog needs.
#
# The live applier is ../apply-theme-v2.ps1. Kept only for history.
# =============================================================================
# Injects custom-theme/pivot-theme-v2.css/.js into the running LobeHub container
# (all SPA stylesheets + shared vendor runtime modules), idempotently.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1           # apply / update
#   powershell -ExecutionPolicy Bypass -File apply-theme-v2.ps1 -Remove   # uninstall
#
# Re-run after every LobeHub container recreation (upgrades wipe the container
# filesystem). After applying, hard-refresh the browser (Ctrl+Shift+R).
# =============================================================================
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$themeRoot = Split-Path -Parent $PSScriptRoot
$css = Join-Path $themeRoot 'pivot-theme-v2.css'
$js = Join-Path $themeRoot 'pivot-theme-v2.js'
$applier = Join-Path $themeRoot 'pivot-apply.js'

if (-not $Remove) {
  foreach ($f in @($css, $js, $applier)) {
    if (-not (Test-Path $f)) { Write-Error "missing file: $f"; exit 1 }
  }
}

Write-Host "[pivot] copying theme files into the lobechat container..."
if (-not $Remove) {
  docker cp $css lobechat:/tmp/pivot-theme-v2.css | Out-Null
  docker cp $js lobechat:/tmp/pivot-theme-v2.js | Out-Null
}
docker cp $applier lobechat:/tmp/pivot-apply.js | Out-Null

Write-Host "[pivot] applying..."
if ($Remove) {
  docker exec lobechat node /tmp/pivot-apply.js --remove
} else {
  docker exec lobechat node /tmp/pivot-apply.js
}

Write-Host "[pivot] done. Hard-refresh the browser (Ctrl+Shift+R) to see changes."
