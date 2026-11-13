// Build the lean single-file product tour: inline demo screenshots as data URIs.
// Usage: node build-tour.mjs   (reads tour-template.html + ../实机截图-demo/*.png)
// Output: ../产品导览-agent.html  (self-contained, open anywhere)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(here, '..', '实机截图-demo');
const tpl = fs.readFileSync(path.join(here, 'tour-template.html'), 'utf8');

const used = new Set();
const html = tpl.replace(/\{\{IMG:([^}]+)\}\}/g, (_, name) => {
  const file = path.join(shotsDir, name);
  if (!fs.existsSync(file)) throw new Error('missing screenshot: ' + name);
  used.add(name);
  const b64 = fs.readFileSync(file).toString('base64');
  return 'data:image/png;base64,' + b64;
});

const leftover = html.match(/\{\{IMG:[^}]+\}\}/g);
if (leftover) throw new Error('unresolved tokens: ' + leftover.join(','));

const out = path.join(here, '..', '产品导览-agent.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (fs.statSync(out).size / 1048576).toFixed(2), 'MB;', used.size, 'images inlined');