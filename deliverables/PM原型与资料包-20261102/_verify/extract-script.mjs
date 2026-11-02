import { readFileSync, writeFileSync } from 'node:fs';
const htmlPath = process.argv[2];
const out = process.argv[3];
const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('no <script> block found'); process.exit(2); }
writeFileSync(out, m[1], 'utf8');
console.log('extracted', m[1].length, 'chars ->', out);
