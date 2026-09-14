/**
 * PivotAI Theme Applier (runs inside the LobeHub container)
 * Usage: node /tmp/pivot-apply.js [--remove]
 *   default  : inject/update the managed theme block into all SPA bundles
 *   --remove : strip the managed blocks (restore original state)
 * Idempotent: re-running updates the managed block in place.
 */
const fs = require('fs');
const path = require('path');

const REMOVE = process.argv.includes('--remove');
const CSS_SRC = '/tmp/pivot-theme-v2.css';
const JS_SRC = '/tmp/pivot-theme-v2.js';

const CSS_START = '/* == PIVOTAI-THEME-V2:START (managed - do not edit in container) == */';
const CSS_END = '/* == PIVOTAI-THEME-V2:END == */';
const JS_START = '// == PIVOTAI-ENGINE-V2:START (managed - do not edit in container) ==';
const JS_END = '// == PIVOTAI-ENGINE-V2:END ==';

const PUBLIC = '/app/public';

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

// targets: all SPA stylesheets + shared vendor runtime modules
const cssFiles = walk(PUBLIC, (p) => p.endsWith('.css') && p.includes('_spa'));
const jsFiles = walk(PUBLIC, (p) => /vendor-ui-runtime-[^/]*\.js$/.test(p) && p.includes('_spa'));

const block = (start, end, payload) => start + '\n' + payload.trimEnd() + '\n' + end;

function applyBlock(file, start, end, payload) {
  let text = fs.readFileSync(file, 'utf8');
  const backup = file + '.pivot-backup';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (REMOVE) {
    if (s >= 0 && e >= 0) {
      text = (text.slice(0, s) + text.slice(e + end.length)).replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(file, text);
      return 'removed';
    }
    return 'clean';
  }
  const newBlock = block(start, end, payload);
  if (s >= 0 && e >= 0) {
    text = text.slice(0, s) + newBlock + text.slice(e + end.length);
    fs.writeFileSync(file, text);
    return 'updated';
  }
  text = text.trimEnd() + '\n\n' + newBlock + '\n';
  fs.writeFileSync(file, text);
  return 'injected';
}

const cssPayload = fs.existsSync(CSS_SRC) ? fs.readFileSync(CSS_SRC, 'utf8') : '';
const jsPayload = fs.existsSync(JS_SRC) ? fs.readFileSync(JS_SRC, 'utf8') : '';
if (!REMOVE && (!cssPayload || !jsPayload)) {
  console.error('theme sources missing in /tmp — copy pivot-theme-v2.css/.js first');
  process.exit(1);
}

let stats = { css: {}, js: {} };
for (const f of cssFiles) {
  const r = applyBlock(f, CSS_START, CSS_END, cssPayload);
  stats.css[r] = (stats.css[r] || 0) + 1;
}
for (const f of jsFiles) {
  const r = applyBlock(f, JS_START, JS_END, jsPayload);
  stats.js[r] = (stats.js[r] || 0) + 1;
}
console.log('CSS files:', JSON.stringify(stats.css), '| targets:', cssFiles.length);
console.log('JS files:', JSON.stringify(stats.js), '| targets:', jsFiles.length);
if (REMOVE) console.log('managed blocks removed');
else console.log('PivotAI theme v2 applied');
