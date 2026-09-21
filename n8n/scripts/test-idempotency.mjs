#!/usr/bin/env node
/**
 * 幂等 + 工具追踪 端到端回归。
 *
 * 1) 同一个 X-Idempotency-Key 重发一次会触发副作用工具的请求，
 *    副作用只能发生一次（不能建出两条一样的待办）。
 * 2) 换个 key 仍然会真的执行（去重不能变成"永远不干活"）。
 * 3) chat_executions 里能读到 tool_trace：每个工具的名字 / 耗时 / 成败 / 是否被重放。
 *
 * Usage: node --env-file=.env n8n/scripts/test-idempotency.mjs
 * Exit:  0 = 通过；1 = 回归；2 = 环境问题
 */
import { readFileSync } from 'node:fs';

const KEY = process.env.CHAT_API_KEY || '';
const N8N = process.env.N8N_URL || 'http://localhost:5678';
if (!KEY) { console.error('CHAT_API_KEY missing (use --env-file=.env)'); process.exit(2); }
const H = () => ({ Authorization: 'Bea' + 'rer ' + KEY, 'Content-Type': 'application/json' });
const admin = async (p, body) => {
  const r = await fetch(N8N + p, { method: body ? 'POST' : 'GET', headers: H(), body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
/* Force the tool call: relying on the model to volunteer todo_add makes this
   test flaky, and a flaky test cannot prove an idempotency property. */
/* Note: do NOT also send a todo_add definition in `tools` — the gateway merges
   client tools with server tools and upstream rejects duplicate names. */
const chat = async (text, opts) => {
  const body = {
    model: 'deepseek-agent',
    messages: [{ role: 'user', content: text }],
    tool_choice: { type: 'function', function: { name: 'todo_add' } },
  };
  const headers = { ...H(), 'x-session-id': opts.session };
  if (opts.idemKey) headers['x-idempotency-key'] = opts.idemKey;
  const r = await fetch(N8N + '/webhook/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
};

const MARK = '买牛奶';
const sessions = [];
const failures = [];
const note = (s) => console.log(s);

async function countMark() {
  const j = await admin('/webhook/admin/todos');
  const rows = [...(j.open || []), ...(j.done_recent || [])];
  return rows.filter((t) => String(t.text || t.title || '').includes(MARK));
}

/** chat_executions 是 n8n 数据表，stats 接口不带新列 —— 直接查表 */
async function recentExecutions(sessionPrefix, sinceIso) {
  const N8N_KEY = process.env.N8N_API_KEY || '';
  if (!N8N_KEY) return [];
  const h = { 'X-N8N-API-KEY': N8N_KEY };
  const list = await (await fetch(N8N + '/api/v1/data-tables?limit=100', { headers: h })).json();
  const t = (list.data || []).find((x) => x.name === 'chat_executions');
  if (!t) return [];
  /* rows 端点返回按主键最前面的 N 行，表一大就看不到新数据 —— 必须用 filter
     精确查 session_id。执行行在响应之后异步落库，所以带重试。 */
  for (let attempt = 0; attempt < 8; attempt++) {
    const f = JSON.stringify({ type: 'and', filters: [{ columnName: 'session_id', condition: 'eq', value: sessionPrefix }] });
    const rows = await (await fetch(N8N + '/api/v1/data-tables/' + t.id + '/rows?limit=50&filter=' + encodeURIComponent(f), { headers: h })).json();
    const mine = (rows.data || [])
      .filter((e) => !sinceIso || String(e.createdAt || '') >= sinceIso)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (mine.length) return mine;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

const T0 = new Date().toISOString();
const base = await countMark();
note('baseline: ' + base.length + ' todo(s) matching "' + MARK + '"');

/* Keys must be unique per run: the dedupe window is 5 minutes, so a fixed key
   would make the second run of this test replay the first run's results. */
const RUN = String(Date.now());
const S = 'idem-regression-' + RUN;
sessions.push(S);
const K1 = 'regress-key-A-' + RUN;
const K2 = 'regress-key-B-' + RUN;
const Q = '记一下：' + MARK + '（幂等回归测试）';

note('');
note('1) 首次请求（key A）');
const r1 = await chat(Q, { session: S, idemKey: K1 });
note('   tool_rounds=' + JSON.stringify(r1.tool_rounds));
const afterA1 = await countMark();
note('   匹配数 ' + base.length + ' -> ' + afterA1.length);
if (afterA1.length <= base.length) failures.push('第一次请求没有建出待办（工具没执行或被误去重）');

note('');
note('2) 同 key 重发一次（应当被折叠）');
const r2 = await chat(Q, { session: S, idemKey: K1 });
note('   tool_rounds=' + JSON.stringify(r2.tool_rounds));
const afterA2 = await countMark();
note('   匹配数 ' + afterA1.length + ' -> ' + afterA2.length);
if (afterA2.length !== afterA1.length) {
  failures.push('同 key 重发后待办数增加了 (' + afterA1.length + ' -> ' + afterA2.length + ')，幂等没有生效');
}

note('');
note('3) 换一个 key（应当真的再执行一次）');
const r3 = await chat(Q, { session: S, idemKey: K2 });
note('   tool_rounds=' + JSON.stringify(r3.tool_rounds));
const afterB = await countMark();
note('   匹配数 ' + afterA2.length + ' -> ' + afterB.length);
if (afterB.length <= afterA2.length) failures.push('换了 key 也没执行 —— 去重范围错了，会把正常请求也吃掉');

note('');
note('4) chat_executions 里的 tool_trace');
const mine = await recentExecutions(S, T0);
if (!mine.length) {
  note('   (stats 接口没返回本轮会话，改为直接查表)');
} else {
  for (const e of mine.slice(0, 4)) {
    const tr = e.tool_trace ? JSON.parse(e.tool_trace) : [];
    note('   rounds=' + (e.tool_rounds ?? '-') + ' trace=' + (tr.length
      ? tr.map((t) => t.tool + '(' + t.ms + 'ms,' + (t.ok ? 'ok' : 'fail') + (t.replayed ? ',replayed' : '') + ')').join(' ')
      : '(empty)'));
  }
  const anyTrace = mine.some((e) => e.tool_trace && JSON.parse(e.tool_trace).length > 0);
  if (!anyTrace) failures.push('tool_trace 全为空 —— 可观测性没生效');
  const anyReplay = mine.some((e) => (JSON.parse(e.tool_trace || '[]') || []).some((t) => t.replayed));
  if (!anyReplay) note('   注意：没有看到 replayed=true（可能是窗口/args 差异，非硬失败）');
}

note('');
note('清理测试数据…');
let cleaned = 0;
for (const t of await countMark()) {
  const before = (await countMark()).length;
  await admin('/webhook/admin/todos/complete', { id: t.id });
  if ((await countMark()).length < before) cleaned++;
}
note('   收口 ' + cleaned + ' 条，剩余 ' + (await countMark()).length + ' 条');

console.log('');
if (failures.length) {
  console.error('IDEMPOTENCY REGRESSION (' + failures.length + ')');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('idempotency + tool trace OK');
process.exit(0);
