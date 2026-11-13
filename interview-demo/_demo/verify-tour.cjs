// Verify the tour deck: no overflow at 1080p/768p, images loaded & legible, shoot each slide.
// Usage: NODE_PATH=$(npm root -g) node verify-tour.cjs [outDir]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const DECK = 'file:///' + path.join(ROOT, 'interview-demo', '产品导览-agent.html').replace(/\\/g, '/');
const OUT = process.argv[2] || path.join(ROOT, 'interview-demo', '_scratch', 'tour-check');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const vp of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(DECK, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(800);
    const n = await page.evaluate(() => document.querySelectorAll('.slide').length);
    let bad = 0;
    for (let k = 0; k < n; k++) {
      await page.evaluate((k) => {
        const s = [...document.querySelectorAll('.slide')];
        s.forEach((x, j) => x.classList.toggle('active', j === k));
      }, k);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const s = document.querySelector('.slide.active');
        const imgs = [...s.querySelectorAll('img')].map((im) => {
          const r = im.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), ok: im.complete && im.naturalWidth > 0 };
        });
        return {
          pageScroll: document.documentElement.scrollHeight > innerHeight + 1,
          slideOverflow: s.scrollHeight > s.clientHeight + 1,
          imgs,
        };
      });
      const small = m.imgs.filter((x) => !x.ok || x.w < 200 || x.h < 140);
      const flag = m.pageScroll || m.slideOverflow || small.length;
      if (flag) bad++;
      console.log(`vp${vp.height} slide${String(k + 1).padStart(2)} overflow=${m.pageScroll || m.slideOverflow} imgs=${m.imgs.map((x) => x.w + 'x' + x.h).join(',')}${small.length ? '  <<SMALL/BROKEN' : ''}`);
      if (vp.height === 1080) {
        await page.screenshot({ path: path.join(OUT, `slide-${String(k + 1).padStart(2, '0')}.png`) });
      }
    }
    console.log(`vp${vp.height}: ${n} slides, ${bad} problem slides`);
    await ctx.close();
  }
  await browser.close();
  console.log('shots ->', OUT);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });