// Drive a REAL agent turn in the console Ai-chat (Live Gateway) and capture it.
// Usage: NODE_PATH=$(npm root -g) node drive-chat.cjs "<prompt>" <outName> [waitMs]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '实机截图-agent');
const PROMPT = process.argv[2] || '先检索私域知识库里关于平台架构的内容，再列出我未完成的待办，最后用一句话总结。';
const NAME = process.argv[3] || '02_ai_chat.png';
const WAIT = parseInt(process.argv[4] || '30000', 10);

function readKey() {
  const m = fs.readFileSync(path.join(ROOT, 'frontent', '.env.local'), 'utf8').match(/^CLERK_SECRET_KEY=(.+)$/m);
  return m[1].trim().replace(/\r$/, '');
}
async function mint(sk, uid) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch('https://api.clerk.com/v1/sign_in_tokens', { method: 'POST', headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: uid, expires_in_seconds: 1800 }) });
      const j = await r.json(); if (j.token) return j.token;
    } catch (e) { /* transient network; retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('no ticket after retries');
}
(async () => {
  const sk = readKey();
  const ticket = await mint(sk, process.env.CLERK_USER_ID || 'user_3J4p5MG3RHggEKq5ee5WCOO27Vw');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/auth/sign-in?__clerk_ticket=' + ticket, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL('**/dashboard/**', { timeout: 45000 });
  try { const b = page.getByRole('button', { name: /remove it myself/i }); if (await b.count()) await b.first().click({ timeout: 2000 }); } catch (e) {}
  await page.addStyleTag({ content: '.cl-modalBackdrop,.cl-modalContent{display:none !important;}' });
  await page.goto('http://localhost:3000/dashboard/ai-chat', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  // Clerk dev-mode modal re-appears per navigation; dismiss + strip it here.
  try { const b2 = page.getByRole('button', { name: /remove it myself/i }); if (await b2.count()) await b2.first().click({ timeout: 2000 }); } catch (e) {}
  await page.addStyleTag({ content: '.cl-modalBackdrop,.cl-modalContent{display:none !important;pointer-events:none !important;}' });
  await page.evaluate(() => { document.querySelectorAll('.cl-modalBackdrop,.cl-modalContent').forEach((n) => n.remove()); });
  await page.waitForTimeout(400);
  const box = page.getByPlaceholder(/向平台智能体发送消息/);
  await box.click();
  await box.fill(PROMPT);
  await page.waitForTimeout(300);
  await box.press('Enter');
  console.log('sent prompt, waiting', WAIT, 'ms for tool loop + model...');
  await page.waitForTimeout(WAIT);
  // Expand the "思考过程与工具调用" disclosure so the tool loop is visible.
  try {
    const tog = page.getByText(/思考过程与工具调用/).first();
    if (await tog.count()) { await tog.click({ timeout: 3000 }); await page.waitForTimeout(800); }
  } catch (e) {}
  // log visible conversation text (trimmed) to verify a real reply + tools
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
  console.log('--- page text (last 1200 chars) ---');
  console.log(txt.slice(-1200));
  await page.addStyleTag({ content: '.cl-modalBackdrop,.cl-modalContent{display:none !important;}' });
  await page.screenshot({ path: path.join(OUT, NAME), fullPage: true });
  console.log('saved', NAME);
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });