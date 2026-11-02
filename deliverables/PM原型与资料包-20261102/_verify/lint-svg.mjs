import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.argv[2] || '.', 'figma');
let fail = 0;
for (const f of readdirSync(dir).filter(x => x.endsWith('.svg'))) {
  const s = readFileSync(join(dir, f), 'utf8');
  const errs = [];

  // 1) 标签栈平衡
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(s))) {
    const [, close, name, attrs, selfClose] = m;
    if (name === '?xml' || name === '!DOCTYPE') continue;
    if (close) {
      const top = stack.pop();
      if (top !== name) errs.push(`第 ${s.slice(0, m.index).split('\n').length} 行：</${name}> 与栈顶 <${top}> 不匹配`);
    } else if (!selfClose) stack.push(name);
    // 2) 属性必须双引号
    if (/[\s=][a-zA-Z-]+=([^"'])/.test(attrs + ' ')) errs.push(`<${name}> 存在未加引号属性`);
  }
  if (stack.length) errs.push('未闭合标签：' + stack.join(','));

  // 3) 文本里的裸 & / < （注释头与实体除外）
  const noComments = s.replace(/<!--[\s\S]*?-->/g, '');
  const badAmp = noComments.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g);
  if (badAmp) errs.push(`裸 & 出现 ${badAmp.length} 次（Figma 导入会直接失败）`);

  // 4) 必须有 viewBox 与 xmlns
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) errs.push('缺 xmlns');
  if (!/viewBox="0 0 \d+ \d+"/.test(s)) errs.push('缺 viewBox');

  // 5) 布局体检：祖先 translate 累加后，元素越界与 Card 重叠
  const frame = s.match(/viewBox="0 0 (\d+) (\d+)"/);
  const FW = frame ? Number(frame[1]) : 0, FH = frame ? Number(frame[2]) : 0;
  const cards = [];
  const xform = [];
  let ox = 0, oy = 0, checked = 0;
  const attr = (at, k) => { const m = at.match(new RegExp(' ' + k + '="(-?[\\d.]+)"')); return m ? Number(m[1]) : null; };
  const nodeRe = /<(\/?)(g|rect|text)\b([^>]*?)(\/?)>/g;
  let n;
  while (frame && (n = nodeRe.exec(s))) {
    const [, close, tag, at, selfClose] = n;
    if (close) { if (tag === 'g') { const p = xform.pop(); ox = p ? p[0] : 0; oy = p ? p[1] : 0; } continue; }
    if (tag === 'g') {
      xform.push([ox, oy]);
      const tr = at.match(/transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/);
      if (tr) { ox += Number(tr[1]); oy += Number(tr[2]); }
      if (selfClose) { xform.pop(); ox = xform.length ? xform[xform.length-1][0] : 0; oy = xform.length ? xform[xform.length-1][1] : 0; continue; }
      const idm = at.match(/id="Card\/([^"]*)"/);
      if (idm) {
        const r0 = s.slice(nodeRe.lastIndex).match(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
        if (r0) cards.push({ name: idm[1], x: ox + Number(r0[1]), y: oy + Number(r0[2]), w: Number(r0[3]), h: Number(r0[4]) });
      }
      continue;
    }
    const x = attr(at, 'x'), y = attr(at, 'y'), w = attr(at, 'width'), h = attr(at, 'height');
    checked++;
    if (x === null || y === null) { errs.push(`<${tag}> 缺 x/y`); continue; }
    if (tag === 'rect') {
      if (x + ox < -1 || y + oy < -1 || x + ox + w > FW + 1 || y + oy + h > FH + 1)
        errs.push(`rect 越界：abs(${(x+ox).toFixed(0)},${(y+oy).toFixed(0)}) ${w}×${h} 超出画板 ${FW}×${FH}`);
    } else if (x + ox < -1 || y + oy < -1 || x + ox > FW + 1 || y + oy > FH + 1) {
      errs.push(`text 越界：abs(${(x+ox).toFixed(0)},${(y+oy).toFixed(0)})`);
    }
    if (selfClose && tag === 'text') continue;
    if (tag === 'text') { const end = s.indexOf('</text>', n.index); if (end < 0) errs.push('text 未闭合'); nodeRe.lastIndex = end + 7; }
  }
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    const ix = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
    if (ix > 2 && iy > 2) errs.push(`Card 重叠：「${a.name}」×「${b.name}」交叠 ${Math.round(ix)}×${Math.round(iy)}`);
  }

  // 6) Figma 关心的可编辑性：text 图层数 / 命名分组数
  const texts = (s.match(/<text /g) || []).length;
  const groups = (s.match(/<g id="/g) || []).length;
  const unnamed = (s.match(/<g>/g) || []).length;
  const rects = (s.match(/<rect /g) || []).length;

  const ok = errs.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  ·  ${groups} 命名组 / ${rects} 矩形 / ${texts} 文本图层 / ${cards.length} Card / 布局体检 ${checked} 个元素${unnamed ? ' / ' + unnamed + ' 个未命名组' : ''}`);
  errs.forEach(e => console.log('        ⤷ ' + e));
}
console.log(fail === 0 ? `\n全部 SVG 结构合法（${'0'} 个失败）` : `\n${fail} 个文件结构有问题`);
process.exit(fail === 0 ? 0 : 1);
