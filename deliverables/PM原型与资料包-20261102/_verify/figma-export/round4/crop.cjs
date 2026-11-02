// 把整页渲染图按已知网格坐标切成 8 块，逐块核对。
// 网格来自 make-figma-svgs.mjs 的合板布局：列起点 0/1500/3000/4660，行起点 0/960，
// 宽 1440/1440/1440/1440 与 1440/1440/1600/1600，高 900；渲染比例 0.5。
const sharp = require('C:/Users/LINLEE/Desktop/agent-platform/frontent/node_modules/sharp');
const path = require('node:path');

const SRC = process.argv[2] || 'page.png';
const OUT = process.argv[3] || '.';
const S = 0.5;
const COLS = [0, 1500, 3000, 4660];
const WIDTHS = [[1440, 1440, 1440, 1440], [1440, 1440, 1600, 1600]];
const ROWS = [0, 960];

const jobs = [];
ROWS.forEach((ry, ri) => {
  COLS.forEach((cx, ci) => {
    const n = ri * 4 + ci + 1;
    jobs.push({ n, left: Math.round(cx * S), top: Math.round(ry * S), width: Math.round(WIDTHS[ri][ci] * S), height: Math.round(900 * S) });
  });
});

(async () => {
  const meta = await sharp(SRC).metadata();
  console.log(`源图 ${meta.width}×${meta.height}`);
  for (const j of jobs) {
    if (j.left + j.width > meta.width || j.top + j.height > meta.height) {
      console.log(`FAIL  board-${String(j.n).padStart(2, '0')} 裁剪框 ${j.left + j.width}×${j.top + j.height} 超出源图`);
      continue;
    }
    const out = path.join(OUT, `board-${String(j.n).padStart(2, '0')}.png`);
    await sharp(SRC).extract({ left: j.left, top: j.top, width: j.width, height: j.height }).toFile(out);
    console.log(`ok    board-${String(j.n).padStart(2, '0')} ← (${j.left},${j.top}) ${j.width}×${j.height}`);
  }
})().catch(e => { console.error('裁剪失败：', e.message); process.exit(1); });
