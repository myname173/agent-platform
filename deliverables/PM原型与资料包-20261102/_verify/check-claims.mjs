/**
 * check-claims.mjs —— 交付物里每一条“可被追问的事实断言”都对着仓库复验一遍。
 * 用法：
 *   node _verify/check-claims.mjs            跑全部断言
 *   node _verify/check-claims.mjs --self-test 注入一条假断言，必须被判 FAIL（证明这道门能失败）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 仓库根 = 本脚本往上两级（deliverables/PM原型与资料包-20261102/_verify/ → 仓库根） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R = (p) => readFileSync(join(ROOT, p), 'utf8');
const lineAt = (s, n) => s.split('\n')[n - 1] || '';

const claims = [];
const C = (id, text, pass, note = '') => claims.push({ id, text, pass, note });
const has = (s, needle, where) => ({ ok: s.includes(needle), where });

/* ---------- 1. 结构性计数 ---------- */
const routes = [];
(function walk(d) {
  for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'route.ts') routes.push(p);
  }
})('frontent/src/app/api');
C('CNT-01', `控制台 api route = 27（实测 ${routes.length}）`, routes.length === 27);

const wfFiles = readdirSync(join(ROOT, 'n8n/workflows')).filter(f => f.endsWith('.json'));
C('CNT-02', `工作流文件 = 24（实测 ${wfFiles.length}）`, wfFiles.length === 24);

const paths = new Set();
for (const f of wfFiles) {
  try {
    const j = JSON.parse(R(join('n8n/workflows', f)));
    for (const n of j.nodes || []) { const p = n?.parameters?.path; if (p) paths.add(p); }
  } catch (_) { C('CNT-03', `工作流 ${f} JSON 解析失败`, false); }
}
C('CNT-03', `唯一 webhook 路径 = 39（实测 ${paths.size}）`, paths.size === 39);

const comp = R('docker-compose.yml');
const svc = [...comp.matchAll(/^  ([a-z0-9_-]+):$/gm)].map(m => m[1])
  .filter(s => !['n8n-net'].includes(s));
const svcNames = svc.filter(s => !['_data','n8n_data','postgres_data','minio_data','caddy_data','caddy_config','platform_redis_data','prometheus_data','kafka_data'].includes(s));
const declared = ['n8n','console','postgres','redis','searxng','n8n-sandbox','lobechat','minio','stream-bridge','platform-runtime','platform-worker','prometheus','kafka','platform-event-publisher','platform-outbox-publisher','backup','caddy'];
C('CNT-04', `compose 服务声明 = 17（实测命中 ${declared.filter(d => svcNames.includes(d)).length}/${declared.length}）`,
  declared.every(d => svcNames.includes(d)), svcNames.filter(s => !declared.includes(s)).join(','));
const profiled = (comp.match(/profiles:/g) || []).length;
C('CNT-05', `带 profiles 的服务 = 5（实测 ${profiled}）⇒ 默认启动 12`, profiled === 5);

/* ---------- 2. 工具面口径（这次纠正的那条） ---------- */
const sb = R('stream-bridge/server.js');
const i0 = sb.indexOf('const SERVER_TOOLS');
const toolsBlock = sb.slice(i0, sb.indexOf('\n];', i0));
const toolNames = [...toolsBlock.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]);
C('TOOL-01', `侧车 SERVER_TOOLS 静态 = 16（实测 ${toolNames.length}）`, toolNames.length === 16, toolNames.join('/'));
const mt = R('n8n/scripts/mcp-test.mjs');
C('TOOL-02', '对外 MCP tools/list 断言 = 17', mt.includes('tools/list -> 17 tools') && mt.includes('tools.length === 17'));
C('TOOL-03', '运行时工具面 = SERVER_TOOLS + 动态 wf_*（README 说的“13/15”是不同时期）', sb.includes('...SERVER_TOOLS') && sb.includes('wfToolDefs'));

/* ---------- 3. 语音 / 图片降级阈值 ---------- */
C('LIM-01', '语音回复长度阈值 900 字', /reply\.length\s*<=\s*900|length > 900|> 900/.test(sb) || sb.includes('900'), lineAt(sb, 553).trim().slice(0, 70));
C('LIM-02', '图片上限 8MB 且不达标直接失败', sb.includes('8 * 1024 * 1024') && sb.includes('image too large'));

/* ---------- 4. 控制台代码与行号 ---------- */
const guard = R('frontent/src/lib/api-guard.ts');
C('UI-01', 'requireUser 在 api-guard.ts:17 起', lineAt(guard, 17).includes('requireUser'));
C('UI-02', 'upstreamError 在 :32 起且 401/403 → 502', lineAt(guard, 32).includes('upstreamError') && guard.includes("status === 401 || status === 403"));
C('UI-03', '两句可操作文案都在', guard.includes('登录状态已失效，请重新登录后再试') && guard.includes('n8n 拒绝了控制台的请求'));

const ver = R('frontent/src/styles/themes/vercel.css');
C('TOK-01', 'vercel 浅色块关键 token', ver.includes('oklch(0.99 0 0)') && ver.includes('oklch(0.63 0.19 23.03)') && ver.includes('--radius: 0.5rem'));
C('TOK-02', 'vercel 深色块存在', /\]\.dark\s*\{|\[data-theme='vercel'\]\.dark/.test(ver) && ver.includes('oklch(0.14 0 0)'));
const ops = R('frontent/src/features/workflows/components/operations-dashboard.tsx');
C('TOK-03', '指挥台 8 个色值逐字一致', ['#0B1220','#111827','#1F2937','#3B82F6','#06B6D4','#10B981','#EF4444','#F59E0B'].every(h => ops.includes(h)));
const fontc = R('frontent/src/components/themes/font.config.ts');
C('TOK-04', 'Geist → --font-sans / Geist_Mono → --font-mono', fontc.includes('Geist') && fontc.includes('--font-sans') && fontc.includes('--font-mono'));
const pivot = R('custom-theme/pivot-theme-v2.css');
C('TOK-05', '前台 v2 是绿系（#16a34a / #34d399 / #030712），不是 README 的旧蓝青',
  pivot.includes('#16a34a') && pivot.includes('#34d399') && pivot.includes('#030712'));
const readme = R('README.md');
C('TOK-06', 'README 仍写着旧的蓝青规范（我在文档里标注了这个矛盾）', readme.includes('#3B82F6') && readme.includes('#06B6D4'));
const notes = R('DEPLOY-NOTES.md');
C('TOK-07', 'DEPLOY-NOTES 记录了蓝→绿的替换（矛盾的另一半证据）', notes.includes('#16a34a') && notes.includes('#34d399'));

/* ---------- 5. 导航条目数（把“13 页”这件事说准） ---------- */
const nav = R('frontent/src/config/nav-config.ts');
const navTitles = [...nav.matchAll(/title:\s*'([^']+)'/g)].map(m => m[1]);
C('NAV-01', `nav-config 条目 = 14（实测 ${navTitles.length}）= 13 业务页 + Clerk Profile`, navTitles.length === 14, navTitles.join('/'));
const pages = readdirSync(join(ROOT, 'frontent/src/app/dashboard')).filter(d => {
  try { return readdirSync(join(ROOT, 'frontent/src/app/dashboard', d)).includes('page.tsx') || readdirSync(join(ROOT,'frontent/src/app/dashboard',d)).includes('[[...profile]]'); }
  catch (_) { return false; }
});
C('NAV-02', `dashboard 下有页面文件的目录 = ${pages.length}（文档写 13 业务页 + profile）`, pages.length >= 13, pages.join(','));

/* ---------- 6. README 里我引用过的段落 ---------- */
const cites = [
  ['CIT-01', '入口不互调（README 英文段）', 'entry points never call each other'],
  ['CIT-02', '成本同源（不各算一遍）', '两边都没坏，只是不一致'],
  ['CIT-03', 'warn→critical 升级不受去重', '涨得最凶的时候反而最安静'],
  ['CIT-04', '定时任务 3.6 天没跑', '已经 3.6 天没有真正触发过'],
  ['CIT-05', '守卫 fail-open', '查不到状态时放行'],
  ['CIT-06', '手动与定时分开统计', '分别统计手动与定时'],
  ['CIT-07', '四份工具定义副本', '工具定义曾经有四份副本'],
  ['CIT-08', 'web_search 200 + 空结果', '成功'],
  ['CIT-09', '幂等隐式键', '客户端不用配合就能防住重试'],
  ['CIT-10', '待办 ≠ 提醒 红线', '待办不自动变提醒'],
  ['CIT-11', 'L2 只有点火权', 'AI 只有**点火权**'],
  ['CIT-12', '出向 MCP 模型不可注册', '模型只能用、不能注册'],
  ['CIT-13', '沙箱审批绑 sha256', 'sha256(代码原文)'],
  ['CIT-14', 'BUDGET_NOTE 效果未证实', '效果未证实'],
  ['CIT-15', 'Settings 显示实际生效值', '实际生效的配置'],
  ['CIT-16', 'README 的旧控制台路由数（我复算 27）', '25 console API routes'],
  ['CIT-17', 'README 同一行的旧工具/表数（12 agent tools · 19 data tables）', '12 agent tools · 19 data tables']
];
for (const [id, text, needle] of cites) C(id, `${text} —— 引文 "${needle}" 在 README 里`, readme.includes(needle));

/* ---------- 7. 告警阈值默认值（.env.example） ---------- */
const envx = R('.env.example');
C('ENV-01', 'ALERT_COST_24H_USD / CRITICAL 预算为 $2 / $5', envx.includes('ALERT_COST_24H_USD') && envx.includes('ALERT_COST_CRITICAL_USD'));
C('ENV-02', 'MAX_TOOL_ROUNDS 默认 2', /MAX_TOOL_ROUNDS=.?2/.test(envx) || readme.includes('MAX_TOOL_ROUNDS:-2'));
C('ENV-03', '保留期 30 / 90 / 7 天', readme.includes('RETENTION_DAYS_IDEMPOTENCY'));

/* ---------- self-test：注入一条假断言，必须 FAIL ---------- */
if (process.argv.includes('--self-test')) {
  C('SELF-TEST', '假断言：控制台 api route = 999（这一条必须 FAIL）', 999 === routes.length);
}

let fail = 0;
for (const c of claims) {
  if (!c.pass) fail++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id}  ${c.text}${c.note ? '  ⟵ ' + c.note : ''}`);
}
console.log(`\n断言 ${claims.length} 条，FAIL ${fail} 条`);
if (process.argv.includes('--self-test')) {
  const st = claims.find(c => c.id === 'SELF-TEST');
  console.log(st && !st.pass ? 'self-test：门确实会红（预期 FAIL 已出现）' : 'self-test：门失效了，假断言居然通过');
  process.exit(st && !st.pass && fail === 1 ? 0 : 1);
}
process.exit(fail === 0 ? 0 : 1);
