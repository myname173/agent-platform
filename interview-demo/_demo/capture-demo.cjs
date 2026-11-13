// Isolated-demo console capture via global Playwright + cached Chromium.
// Targets the DEMO stack (console :13000, Jaeger :16686) — zero production touch.
// Mints a Clerk passwordless ticket, logs in once, drives real agent turns in the
// ai-chat playground, then shoots dashboard pages and a Jaeger trace waterfall.
// Usage: NODE_PATH=$(npm root -g) node capture-demo.cjs [outDir] [mode]
//   mode = all | chat | pages | jaeger   (default all)
// Never prints the Clerk secret or the ticket.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(ROOT, 'interview-demo', '实机截图-demo');
const MODE = process.argv[3] || 'all';
const CONSOLE = 'http://localhost:13000';
const JAEGER = 'http://localhost:16686';

const PAGES = [
  ['/dashboard/overview', '01_overview.png'],
  ['/dashboard/knowledge', '03_knowledge.png'],
  ['/dashboard/workflows', '09_workflows.png'],
  ['/dashboard/people', '06_people.png'],
  ['/dashboard/projects', '33_projects.png'],
  ['/dashboard/docs', '10_docs.png'],
  ['/dashboard/briefs', '30_briefs.png'],
  ['/dashboard/topics', '31_topics.png'],
  ['/dashboard/keys', '04_keys.png'],
  ['/dashboard/alerts', '07_alerts.png'],
  ['/dashboard/models', '05_models.png'],
  ['/dashboard/settings', '32_settings.png'],
];

// Real agent turns, each captured as its own clean conversation.
const CHAT_TURNS = [
  ['报销超过五千元需要谁审批？', '02_ai_chat_kb.png', false],
  ['帮我搜一下 2026 年主流 AI Agent 框架有哪些新进展', '02_ai_chat_web.png', true],
  ['记一下：明天下午三点提交项目周报，派给张伟', '02_ai_chat_action.png', false],
];

function readKey() {
  const txt = fs.readFileSync(path.join(ROOT, 'frontent', '.env.local'), 'utf8');
  const m = txt.match(/^CLERK_SECRET_KEY=(.+)$/m);
  if (!m) throw new Error('CLERK_SECRET_KEY missing');
  return m[1].trim().replace(/\r$/, '');
}
async function mintTicket(sk, userId) {
  const r = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST', headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 1800 }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('no ticket: ' + JSON.stringify(j).slice(0, 200));
  return j.token;
}
async function dismissClerk(page) {
  try {
    const btn = page.getByRole('button', { name: /remove it myself/i });
    if (await btn.count()) { await btn.first().click({ timeout: 2000 }); await page.waitForTimeout(600); }
  } catch (e) {}
  try { await page.addStyleTag({ content: '.cl-modalBackdrop,.cl-modalContent{display:none !important;}' }); } catch (e) {}
}

async function shoot(page, route, name, waitMs = 3500) {
  await page.goto(CONSOLE + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(waitMs);
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch (e) {}
  await dismissClerk(page);
  await page.waitForTimeout(400);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log('saved', name, fs.statSync(file).size, 'bytes');
}

async function chatTurn(page, prompt, name, alsoTail = false) {
  await page.goto(CONSOLE + '/dashboard/ai-chat', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await dismissClerk(page);
  // Unique session per turn so server-side memory doesn't bleed prior turns in.
  const sess = page.locator('input[placeholder^="会话 id"]');
  if (await sess.count()) { await sess.fill('demo-' + name.replace(/[^a-z0-9]/gi, '') + '-' + Date.now()); }
  const input = page.locator('input[placeholder^="向平台智能体"]');
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  // streaming started -> 停止 button appears; done -> input re-enabled
  await page.waitForSelector('button:has-text("停止")', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => {
    const i = document.querySelector('input[placeholder^="向平台智能体"]');
    return i && !i.disabled;
  }, undefined, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await dismissClerk(page);
  // Frame the loop from the top: question -> reasoning -> tool calls -> answer head.
  const setScroll = (mode) => page.evaluate((m) => {
    const el = document.querySelector('.overflow-y-auto.space-y-4');
    if (el) el.scrollTop = m === 'top' ? 0 : el.scrollHeight;
  }, mode);
  await setScroll('top');
  await page.waitForTimeout(400);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  if (alsoTail) {
    await setScroll('bottom');
    await page.waitForTimeout(400);
    const tailFile = path.join(OUT, name.replace(/\.png$/, '_tail.png'));
    await page.screenshot({ path: tailFile, fullPage: true });
    console.log('saved', path.basename(tailFile), fs.statSync(tailFile).size, 'bytes (answer tail)');
  }
  // report the rendered assistant text length so we can tell grounded vs generic
  const txt = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.whitespace-pre-wrap')];
    return bubbles.map((b) => b.textContent || '').filter((t) => t.length > 20).pop() || '';
  });
  console.log('saved', name, fs.statSync(file).size, 'bytes | answer_chars=', txt.length, '| head=', txt.slice(0, 70).replace(/\n/g, ' '));
}

async function kbDrill(page, query, name) {
  await page.goto(CONSOLE + '/dashboard/knowledge', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await dismissClerk(page);
  await page.getByRole('tab', { name: /检索演练/ }).click();
  await page.waitForTimeout(800);
  const input = page.locator('input[placeholder^="输入查询语句"]');
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill(query);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  // wait for result cards (Skeleton -> content); ScoreBadge shows "% 匹配"
  await page.waitForFunction(() => /% 匹配/.test(document.body.innerText), undefined, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await dismissClerk(page);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true });
  const n = await page.evaluate(() => (document.body.innerText.match(/% 匹配/g) || []).length);
  console.log('saved', name, fs.statSync(file).size, 'bytes | result_cards=', n);
}

async function jaeger(page) {
  // pick the richest n8n trace via the API, then open its waterfall directly
  let traceId = null, spanCount = 0;
  try {
    const r = await fetch(`${JAEGER}/api/traces?service=n8n&limit=100&lookback=3h`);
    const j = await r.json();
    for (const t of (j.data || [])) { if (t.spans.length > spanCount) { spanCount = t.spans.length; traceId = t.traceID; } }
  } catch (e) { console.log('jaeger api fail', String(e.message).slice(0, 80)); }
  // search page (service list) first
  await page.goto(JAEGER + '/search?service=n8n', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, '40_jaeger_search.png'), fullPage: true });
  console.log('saved 40_jaeger_search.png');
  if (traceId) {
    await page.goto(JAEGER + '/trace/' + traceId, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    // expand the trace tree fully if a collapse toggle exists
    await page.screenshot({ path: path.join(OUT, '41_jaeger_trace.png'), fullPage: true });
    console.log('saved 41_jaeger_trace.png | spans=', spanCount, 'trace=', traceId.slice(0, 12));
  } else {
    console.log('NO n8n trace found in Jaeger');
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const sk = readKey();
  const userId = process.env.CLERK_USER_ID || 'user_3J4p5MG3RHggEKq5ee5WCOO27Vw';
  const ticket = await mintTicket(sk, userId);
  console.log('ticket minted (hidden); mode=', MODE, 'out=', OUT);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(CONSOLE + '/auth/sign-in?__clerk_ticket=' + ticket, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL('**/dashboard/**', { timeout: 45000 });
  console.log('logged in ->', page.url());
  await dismissClerk(page);

  if (MODE === 'all' || MODE === 'chat') {
    for (const [prompt, name, alsoTail] of CHAT_TURNS) {
      if (process.env.DEMO_ONLY && !name.includes(process.env.DEMO_ONLY)) continue;
      try { await chatTurn(page, prompt, name, alsoTail); }
      catch (e) { console.log('FAIL chat', name, String(e.message).slice(0, 140)); }
    }
  }
  if (MODE === 'all' || MODE === 'pages') {
    for (const [route, name] of PAGES) {
      try { await shoot(page, route, name); }
      catch (e) { console.log('FAIL', name, String(e.message).slice(0, 120)); }
    }
  }
  if (MODE === 'all' || MODE === 'drill') {
    try { await kbDrill(page, '报销超过五千元需要谁审批？', '03_knowledge_search.png'); }
    catch (e) { console.log('FAIL drill', String(e.message).slice(0, 140)); }
  }
  if (MODE === 'all' || MODE === 'jaeger') {
    try { await jaeger(page); } catch (e) { console.log('FAIL jaeger', String(e.message).slice(0, 140)); }
  }
  await browser.close();
  console.log('done');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });