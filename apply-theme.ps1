# Apply PivotAI Theme to LobeChat Docker Container
Write-Host "Applying PivotAI Cyber Theme to LobeChat container..." -ForegroundColor Cyan

docker cp custom-theme/pivot-theme.css lobechat:/app/pivot-theme.css
docker cp custom-theme/pivot-theme.js lobechat:/app/pivot-theme.js

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
