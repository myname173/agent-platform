# =============================================================================
# [LEGACY - DO NOT USE] PivotAI theme v1 applier for LobeChat 1.x
#
# Archived on 2026-10-27. This script CANNOT work on the current LobeHub 2.x
# container: it writes into hardcoded LobeChat 1.x build artifacts
# (/app/.next/static/css/967104e9fd9cfb93.css and main-app-*.js), which do not
# exist in the 2.x image (2.x serves /app/public/_spa/**).
#
# The live applier is ../apply-theme-v2.ps1. Kept only for history.
# =============================================================================
Write-Host "[LEGACY] PivotAI theme v1 (LobeChat 1.x only) - will not work on LobeHub 2.x" -ForegroundColor Yellow

$v1Dir = $PSScriptRoot
docker cp "$v1Dir/pivot-theme.css" lobechat:/app/pivot-theme.css
docker cp "$v1Dir/pivot-theme.js" lobechat:/app/pivot-theme.js

docker exec lobechat node -e "
const fs = require('fs');

const cssTheme = fs.readFileSync('/app/pivot-theme.css', 'utf8');
const jsTheme = fs.readFileSync('/app/pivot-theme.js', 'utf8');

// Target 1: CSS
const cssFile = '/app/.next/static/css/967104e9fd9cfb93.css';
let css = fs.readFileSync(cssFile, 'utf8');
// Clean previous injections if any
const markerCSS = '/* ==========================================================================\n   PivotAI Cyber Glassmorphism';
if (css.includes(markerCSS)) {
  css = css.split(markerCSS)[0].trimEnd();
}
fs.writeFileSync(cssFile, css + '\n\n' + cssTheme + '\n');
console.log('Injected PivotAI CSS into', cssFile);

// Target 2: JS
const jsFile = '/app/.next/static/chunks/main-app-6b964e13d53cccd4.js';
let js = fs.readFileSync(jsFile, 'utf8');
const markerJS = '/**\n * PivotAI Dynamic Cyber Engine';
if (js.includes(markerJS)) {
  js = js.split(markerJS)[0].trimEnd();
}
fs.writeFileSync(jsFile, js + '\n\n' + jsTheme + '\n');
console.log('Injected PivotAI JS into', jsFile);
"

Write-Host "PivotAI Theme Applied Successfully!" -ForegroundColor Green
