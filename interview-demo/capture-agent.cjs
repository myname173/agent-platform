// Machine-local console capture via global Playwright + cached Chromium.
// Single run: mint a Clerk passwordless ticket, log in once, shoot every page
// at 1600x1000 (matches the existing deck), fullPage body screenshots.
// Usage: NODE_PATH=$(npm root -g) node capture-agent.cjs [outDir] [pageFilter]
// Never prints the Clerk secret or the ticket.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(__dirname, '实机截图-agent');
const FILTER = process.argv[3] || '';

const PAGES = [
  ['/dashboard/overview', '01_overview.png'],
  ['/dashboard/ai-chat', '02_ai_chat.png'],
  ['/dashboard/knowledge', '03_knowledge.png'],
  ['/dashboard/keys', '04_keys.png'],
  ['/dashboard/models', '05_models.png'],
  ['/dashboard/people', '06_people.png'],
  ['/dashboard/alerts', '07_alerts.png'],
  ['/dashboard/workflows', '09_workflows.png'],
  ['/dashboard/docs', '10_docs.png'],
  ['/dashboard/briefs', '30_briefs.png'],
  ['/dashboard/topics', '31_topics.png'],
  ['/dashboard/settings', '32_settings.png'],
  ['/dashboard/projects', '33_projects.png'],
];

function readKey() {
  const txt = fs.readFileSync(path.join(ROOT, 'frontent', '.env.local'), 'utf8');
  const m = txt.match(/^CLERK_SECRET_KEY=(.+)$/m);
  if (!m) throw new Error('CLERK_SECRET_KEY missing');
  return m[1].trim().replace(/\r$/, '');
}

async function mintTicket(sk, userId) {
  const r = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 1800 }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('no ticket: ' + JSON.stringify(j).slice(0, 200));
  return j.token;
}

async function dismissClerk(page) {
  // Click the dev-mode "I'll remove it myself" if present, then hide any modal.
  try {
    const btn = page.getByRole('button', { name: /remove it myself/i });
    if (await btn.count()) { await btn.first().click({ timeout: 2000 }); await page.waitForTimeout(600); }
  } catch (e) {}
  try {
    await page.addStyleTag({ content: '.cl-modalBackdrop,.cl-modalContent{display:none !important;}' });
  } catch (e) {}
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const sk = readKey();
  const userId = process.env.CLERK_USER_ID || 'user_3J4p5MG3RHggEKq5ee5WCOO27Vw';
  const ticket = await mintTicket(sk, userId);
  console.log('ticket minted (hidden)');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/auth/sign-in?__clerk_ticket=' + ticket, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL('**/dashboard/**', { timeout: 45000 });
  console.log('logged in ->', page.url());
  await dismissClerk(page);

  const targets = PAGES.filter(([p, n]) => !FILTER || n.includes(FILTER) || p.includes(FILTER));
  for (const [route, name] of targets) {
    try {
      await page.goto('http://localhost:3000' + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
      try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch (e) {}
      await dismissClerk(page);
      await page.waitForTimeout(400);
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, fullPage: true });
      const sz = fs.statSync(file).size;
      console.log('saved', name, sz, 'bytes');
    } catch (e) {
      console.log('FAIL', name, String(e.message).slice(0, 120));
    }
  }
  await browser.close();
  console.log('done');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });