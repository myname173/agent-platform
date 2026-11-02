/**
 * make-bbox-page.mjs —— 用渲染器自己的几何（getBBox）来判越界，
 * 取代我原先只量 rect/text 的正则检查（那次漏掉了 ellipse，Figma 直接把 06 报成 1800×1160）。
 *
 * 生成 _verify/bbox-check.html：把每个 SVG 内联进去，页面里算所有图形的并集包围盒，
 * 与声明的 viewBox 比对，输出溢出方向与像素数。
 * 用法： node _verify/make-bbox-page.mjs   然后浏览器打开 _verify/bbox-check.html
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIGMA = resolve(HERE, '..', 'figma');
const files = readdirSync(FIGMA).filter(f => f.endsWith('.svg')).sort();

const blocks = files.map(f => {
  const raw = readFileSync(join(FIGMA, f), 'utf8');
  const vb = (raw.match(/viewBox="0 0 (\d+) (\d+)"/) || []).slice(1).map(Number);
  // 内联整个 <svg>（不是只塞子节点）：子节点脱离 SVG 命名空间后 getBBox 不可用。
  // CSS 尺寸不影响 getBBox 返回的用户坐标，所以这里保留原 svg 标签即可。
  const inner = raw.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/, '');
  return `<section data-file="${f}" data-w="${vb[0]}" data-h="${vb[1]}">${inner}</section>`;
}).join('\n');

writeFileSync(join(HERE, 'bbox-check.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>SVG 几何越界检查（getBBox）</title><style>body{font:12px system-ui;background:#111;color:#ddd}
/* 关键：不给 svg 加 CSS 缩放。缩到 600px 时 6260 宽的图按 0.096 渲染，
   Chrome 返回的 text getBBox 会比原始尺寸宽约 20%（实测「最近告警」72 vs 60），字框判定就变成测量伪影。 */
svg{display:block;background:#1e1e1e}section{margin:0 0 18px}
.ok{color:#10B981}.bad{color:#EF4444}.warn{color:#F59E0B}table{border-collapse:collapse}
td,th{border-bottom:1px solid #333;padding:5px 8px;text-align:left}</style></head><body>
<h3>越界判定：用 Chromium 的 getBBox()，不是我自己量的</h3>
<table><thead><tr><th>文件</th><th>声明</th><th>图形包围盒（判定用）</th><th>含文本参考</th><th>结果</th></tr></thead><tbody id="tb"></tbody></table>
<div id="report"></div>
<div id="svgs" style="position:absolute;left:-99999px;top:0;width:1200px">${blocks}</div>
<script>
const tb = document.getElementById('tb');
const rows = [];
for (const sec of document.querySelectorAll('#svgs section')) {
  const w = +sec.dataset.w, h = +sec.dataset.h, file = sec.dataset.file;
  const svgEl = sec.querySelector('svg');
  // getBBox() 是元素**自身**用户坐标，不累加祖先 transform —— 合板里必须用 CTM 映射回根坐标，
  // 否则每个 Board 的内容都会叠回 (0,0)，越界根本看不出来。
  const rootInv = svgEl && svgEl.getCTM() ? svgEl.getCTM().inverse() : null;
  const toRoot = (el, b) => {
    if (!rootInv) return { x: b.x, y: b.y, w: b.width, h: b.height };
    const m = rootInv.multiply(el.getCTM());
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
      .map(([px, py]) => { const p = svgEl.createSVGPoint(); p.x = px; p.y = py; return p.matrixTransform(m); });
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const acc = (t) => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, n: 0,
    add(x, y, bw, bh) { this.n++; this.minX = Math.min(this.minX, x); this.minY = Math.min(this.minY, y);
      this.maxX = Math.max(this.maxX, x + bw); this.maxY = Math.max(this.maxY, y + bh); } });
  const shapes = acc(), withText = acc();
  const boards = [];
  const boardAcc = new Map();
  const boxOf = (t) => Math.round(t.maxX - t.minX) + '×' + Math.round(t.maxY - t.minY) + ' @' + Math.round(t.minX) + ',' + Math.round(t.minY);
  for (const el of sec.querySelectorAll('rect,circle,ellipse,line,path,polygon,polyline,text')) {
    let b; try { b = el.getBBox(); } catch (e) { continue; }
    if (!b || (b.width === 0 && b.height === 0 && b.x === 0 && b.y === 0)) continue;
    let r = toRoot(el, b);
    /* 文本宽度：getBBox 用的是回落字体的度量，Figma 会换成自己的字体 —— 只作参考，不判定 */
    if (el.tagName === 'text') {
      const fs = parseFloat(el.getAttribute('font-size') || '13');
      const est = (el.textContent || '').length * fs * 0.62;
      const anchor = el.getAttribute('text-anchor');
      const extra = Math.max(0, est - r.w);
      if (anchor === 'middle') r = { ...r, x: r.x - extra / 2, w: r.w + extra };
      else if (anchor === 'end') r = { ...r, x: r.x - extra, w: r.w + extra };
      else r = { ...r, w: r.w + extra };
    }
    /* 找出元素所属的 Board/* 组，逐 Board 统计 */
    let host = el, boardName = null;
    while (host && host !== sec) {
      const id = host.getAttribute && host.getAttribute('id');
      if (id && id.startsWith('Board/')) { boardName = id; break; }
      host = host.parentElement;
    }
    const targets = el.tagName === 'text' ? [withText] : [shapes, withText];
    targets.forEach(t => t.add(r.x, r.y, r.w, r.h));
    if (boardName) {
      if (!boardAcc.has(boardName)) boardAcc.set(boardName, { shapes: acc(), text: acc() });
      const e = boardAcc.get(boardName);
      (el.tagName === 'text' ? e.text : e.shapes).add(r.x, r.y, r.w, r.h);
    }
  }
  for (const [name, e] of boardAcc) boards.push({ name, shapes: boxOf(e.shapes), n: e.shapes.n, text: boxOf(e.text) });
  /* 文字压字检测：宽度取「Chromium 实际字宽」与「估宽(CJK 1em / 拉丁 0.58em)」的**较大值**。
     只用实际字宽会漏 —— Figma 导入后换成自己的字体度量，比回落字体更宽；
     上一轮 01 表格里 embedding_quota 压 critical 徽标就是这么漏掉的（我本地 0 处、Figma 肉眼可见）。 */
  const textBoxes = [];
  for (const el of sec.querySelectorAll('text')) {
    let b; try { b = el.getBBox(); } catch (e) { continue; }
    if (!b || (b.width === 0 && b.height === 0)) continue;
    const r = toRoot(el, b);
    const fs = parseFloat(el.getAttribute('font-size') || '13');
    const txt = el.textContent || '';
    const est = [...txt].reduce((a, c) => a + (/[㐀-＀-￯〰-〿]/.test(c) ? fs : fs * 0.62), 0);
    const w = Math.max(r.w, est);
    const anchor = el.getAttribute('text-anchor');
    let x = r.x;
    if (anchor === 'middle') x -= (w - r.w) / 2; else if (anchor === 'end') x -= (w - r.w);
    textBoxes.push({ x, y: r.y, w, h: r.h, t: txt.slice(0, 18) });
  }
  const collisions = [];
  for (let i = 0; i < textBoxes.length; i++) for (let j = i + 1; j < textBoxes.length; j++) {
    const a = textBoxes[i], b2 = textBoxes[j];
    const ox = Math.min(a.x + a.w, b2.x + b2.w) - Math.max(a.x, b2.x);
    const oy = Math.min(a.y + a.h, b2.y + b2.h) - Math.max(a.y, b2.y);
    if (ox > 6 && oy > 4) collisions.push(a.t + ' × ' + b2.t + ' (' + Math.round(ox) + '×' + Math.round(oy) + ')');
  }

  const overOf = (t) => ({ left: -t.minX, top: -t.minY, right: t.maxX - w, bottom: t.maxY - h });
  const over = overOf(shapes);
  const bad = Object.entries(over).some(([, v]) => v > 1);
  const overTxt = overOf(withText);
  rows.push({ file, declared: w + '×' + h, shapes: boxOf(shapes), shapesN: shapes.n,
    withText: boxOf(withText), textOnlyOverflow: Object.entries(overTxt).some(([, v]) => v > 1),
    over: Object.entries(over).filter(([, v]) => v > 1).map(([k, v]) => k + ' ' + Math.round(v) + 'px').join(' / ') || '—',
    bad, collisions, boards });
}
for (const r of rows) {
  const tr = document.createElement('tr');
  const shapeCell = r.bad ? '<span class="bad">图形溢出：' + r.over + '</span>' : '<span class="ok">图形在框内</span>';
  const textCell = r.collisions.length ? '<br><span class="bad">文字压字 ' + r.collisions.length + ' 处：' + r.collisions.slice(0, 3).join('；') + (r.collisions.length > 3 ? ' …' : '') + '</span>' : '';
  tr.innerHTML = '<td>' + r.file + '</td><td>' + r.declared + '</td>'
    + '<td>' + r.shapes + '（' + r.shapesN + ' 图形）</td><td>' + r.withText + '</td>'
    + '<td>' + shapeCell + textCell + '</td>';
  tb.appendChild(tr);
  for (const b of r.boards) {
    const br = document.createElement('tr');
    br.innerHTML = '<td style="padding-left:22px;color:#9ca3af">└ ' + b.name + '</td><td>—</td>'
      + '<td>' + b.shapes + '（' + b.n + ' 图形）</td><td>' + b.text + '</td><td class="ok">逐 Board 参考</td>';
    tb.appendChild(br);
  }
}
for (const r of rows) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>' + r.file + '</td><td>' + r.declared + '</td>'
    + '<td>' + r.shapes + '（' + r.shapesN + ' 个图形）</td>'
    + '<td>' + r.withText + '</td>'
    + '<td class="' + (r.bad ? 'bad">图形溢出：' + r.over : 'ok">图形在框内')
    + (r.textOnlyOverflow && !r.bad ? '<br><span class="warn">（含文本参考值略出界，属估宽噪声）</span>' : '') + '</td>';
  tb.appendChild(tr);
}
const bads = rows.filter(r => r.bad || r.collisions.length);
const shapeBads = rows.filter(r => r.bad), textBads = rows.filter(r => r.collisions.length);
document.getElementById('report').innerHTML =
  '<p class="' + (bads.length ? 'bad' : 'ok') + '">' + (bads.length
    ? bads.length + '/' + rows.length + ' 个文件有问题 —— 图形越界 ' + shapeBads.length + ' 个、文字压字 ' + textBads.length + ' 个文件（共 ' + rows.reduce((a, r) => a + r.collisions.length, 0) + ' 处）'
    : '全部 ' + rows.length + ' 个文件：图形在框内，且无文字重叠') + '</p>'
  + '<p class="warn">图形判定 1px 容差；文字压字判定 = 垂直重叠 &gt;4px 且水平重叠 &gt;6px。「含文本参考」列本身不参与越界判定（字体度量差异会带来几 px 假阳性）。</p>';
window.__bbox = rows;
</script></body></html>\n`, 'utf8');

console.log('已生成 bbox-check.html，内联', files.length, '个 SVG：');
files.forEach(f => console.log('  -', f));
