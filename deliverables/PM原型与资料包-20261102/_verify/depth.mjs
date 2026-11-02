import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').split('\n');
const from = Number(process.argv[3] || 1), to = Number(process.argv[4] || lines.length);
let d = 0;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i];
  let inS = null, dd = 0;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (inS) { if (ch === '\\') { j++; continue; } if (ch === inS) inS = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inS = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') dd++;
    if (ch === ')' || ch === '}' || ch === ']') dd--;
  }
  d += dd;
  if (i + 1 >= from && i + 1 <= to) console.log(String(i + 1).padStart(4) + '  depth=' + String(d).padStart(3) + '  ' + s.trim().slice(0, 70));
}
console.log('final depth', d);
