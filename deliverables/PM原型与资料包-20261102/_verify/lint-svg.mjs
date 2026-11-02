import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.argv[2] || '.', 'figma');
let fail = 0;
for (const f of readdirSync(dir).filter(x => x.endsWith('.svg'))) {
  const s = readFileSync(join(dir, f), 'utf8');
  const errs = [];
  const infos = [];

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
  const nodeRe = /<(\/?)(g|rect|text|circle|ellipse|line|path|polygon|polyline)\b([^>]*?)(\/?)>/g;
  let n, uncheckedGeom = 0;
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
    /* path/polygon/polyline 的边界要从 d/points 里解析，这里不硬算 —— 明确计数，绝不静默通过。
       （它们由 bbox-check.html 用渲染器 getBBox 覆盖） */
    if (tag === 'path' || tag === 'polygon' || tag === 'polyline') { uncheckedGeom++; continue; }
    const x = attr(at, 'x'), y = attr(at, 'y'), w = attr(at, 'width'), h = attr(at, 'height');
    /* 图形全覆盖：rect/text 之外，circle 与 ellipse 也必须量。
       之前只量 rect/text，06 的三段 aurora ellipse 越界没被抓到，是 Figma 自己报 1800×1160 才暴露的。 */
    const cx = attr(at, 'cx'), cy = attr(at, 'cy'), r = attr(at, 'r'), rx = attr(at, 'rx'), ry = attr(at, 'ry');
    checked++;
    let bx = null, by = null, bw = 0, bh = 0;
    if (tag === 'rect') { bx = x; by = y; bw = w; bh = h; }
    else if (tag === 'circle') { bx = cx - r; by = cy - r; bw = 2 * r; bh = 2 * r; }
    else if (tag === 'ellipse') { bx = cx - rx; by = cy - ry; bw = 2 * rx; bh = 2 * ry; }
    else if (tag === 'line') {
      const x1 = attr(at, 'x1'), y1 = attr(at, 'y1'), x2 = attr(at, 'x2'), y2 = attr(at, 'y2');
      bx = Math.min(x1, x2); by = Math.min(y1, y2); bw = Math.abs(x2 - x1); bh = Math.abs(y2 - y1);
    }
    else if (tag === 'text') { bx = x; by = y - 4; bw = 0; bh = 0; }   // 文本宽度交给 bbox-check.html
    if (bx === null) { errs.push(`<${tag}> 缺几何属性`); continue; }
    if (tag !== 'text') {
      if (bx + ox < -1 || by + oy < -1 || bx + ox + bw > FW + 1 || by + oy + bh > FH + 1)
        errs.push(`${tag} 越界：abs(${(bx+ox).toFixed(0)},${(by+oy).toFixed(0)}) ${bw}×${bh} 超出画板 ${FW}×${FH}`);
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

  // 5) 渐变/裁剪引用完整性：fill="url(#x)" 悬空时形状会渲染成黑块或消失，
  //    而结构上仍然是合法 XML —— 这类"看不见但不报错"的缺陷必须单独判。
  const definedIds = new Set([...s.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const refs = [...s.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]);
  const dangling = [...new Set(refs)].filter(id => !definedIds.has(id));
  if (dangling.length) errs.push('悬空的渐变/裁剪引用：' + dangling.join(', ') + '（会渲染成黑块或消失）');
  const idCounts = new Map();
  for (const m of s.matchAll(/\sid="([^"]+)"/g)) idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
  const refSet = new Set(refs);
  /* 只有被 url(#id) 引用的 id 重了才是缺陷（渐变/裁剪会串引用）。
     Badge/已触达×2、Sidebar×5 这类是同一组件的多个实例 —— Figma 图层名允许重复，
     把它们判红是我这条检查写错了，不是内容错了，所以降级为提示。 */
  const dupReferenced = [...idCounts].filter(([id, n]) => n > 1 && refSet.has(id)).map(([id, n]) => id + '×' + n);
  if (dupReferenced.length) errs.push('被引用但重复的 id（渐变/裁剪会串引用）：' + dupReferenced.join(', '));
  const dupInfo = [...idCounts].filter(([id, n]) => n > 1 && !refSet.has(id));
  if (dupInfo.length) infos.push('同名组件实例（Figma 图层名可重复，不算缺陷）：' + dupInfo.slice(0, 4).map(([id, n]) => id + '×' + n).join(', '));

  // 6) Figma 关心的可编辑性：text 图层数 / 命名分组数
  const texts = (s.match(/<text /g) || []).length;
  const groups = (s.match(/<g id="/g) || []).length;
  const unnamed = (s.match(/<g>/g) || []).length;
  const rects = (s.match(/<rect /g) || []).length;

  const ok = errs.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  ·  ${groups} 命名组 / ${rects} 矩形 / ${texts} 文本图层 / ${cards.length} Card / 几何判定 ${checked} 个元素 / 交给 getBBox 的 path·polygon ${uncheckedGeom} 个${unnamed ? ' / ' + unnamed + ' 个未命名组' : ''}`);
  errs.forEach(e => console.log('        ⤷ ' + e));
  infos.forEach(i => console.log('        · 提示 ' + i));
}
console.log(fail === 0 ? `\n全部 SVG 结构合法（${'0'} 个失败）` : `\n${fail} 个文件结构有问题`);
process.exit(fail === 0 ? 0 : 1);
