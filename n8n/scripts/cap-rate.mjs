#!/usr/bin/env node
/**
 * 多步编排的"该多深"仪表。
 *
 * 回答两个问题：
 *   1. 有多少请求真的用满了工具轮次上限？（跑满率）
 *   2. 有没有请求在到达上限时还想调工具？（撞顶次数）
 *
 * 怎么读：
 *   - 撞顶 > 0            → 有任务被截断，上限确实太紧
 *   - 跑满率 > 20%        → 大量请求贴着上限走，值得临时提高到 5 观察分布
 *   - 两者都低            → 现在的深度就是对的，别加深（加深只会增加成本和失控面）
 *
 * 关于撞顶恒为 0：这不是 bug。当前设计在到达上限时**把工具列表整个移除**，
 * 模型无从调用，所以 finish_reason 不会是 tool_calls。换句话说"截断"被"收口"
 * 掩盖了 —— 真正的代价不是报错，而是模型可能在信息不足时直接编答案。
 * 想测出"模型到底想要几轮"，必须临时提高 MAX_TOOL_ROUNDS 再看本脚本的分布。
 *
 * Usage: node --env-file=.env n8n/scripts/cap-rate.mjs [days]
 */
import { readFileSync } from 'node:fs';

const N8N = process.env.N8N_URL || 'http://localhost:5678';
const KEY = process.env.N8N_API_KEY || '';
const CHAT = process.env.CHAT_API_KEY || '';
if (!KEY) { console.error('N8N_API_KEY missing (use --env-file=.env)'); process.exit(2); }
const days = Number(process.argv[2] || 7);
const h = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' };
const since = new Date(Date.now() - days * 86400000).toISOString();

const tables = await (await fetch(N8N + '/api/v1/data-tables?limit=100', { headers: h })).json();
const idOf = (n) => {
  const t = (tables.data || []).find((x) => x.name === n);
  return t ? t.id : null;
};
/* Two data-table API traps, both verified on this instance:
   - `sortBy` only works when the colon is percent-encoded (`createdAt%3Adesc`);
     unencoded it silently returns zero rows.
   - a `gte` filter on createdAt is silently ignored, so the endpoint hands back
     the OLDEST rows. Always sort desc and cut the window client-side. */
async function rows(table, filterObj, limit = 250) {
  const id = idOf(table);
  if (!id) return [];
  let qs = 'limit=' + limit + '&sortBy=' + encodeURIComponent('createdAt:desc');
  if (filterObj) qs += '&filter=' + encodeURIComponent(JSON.stringify(filterObj));
  const r = await (await fetch(N8N + '/api/v1/data-tables/' + id + '/rows?' + qs, { headers: h })).json();
  return (r.data || []).filter((e) => String(e.createdAt || '') >= since);
}

/* Only successful turns say anything about loop depth: a rejected or failed
   request never reached the loop. Rows with no tool_rounds are either the
   error path (which logs a row without loop fields) or predate the column. */
const all = (await rows('chat_executions', null, 250))
  .filter((e) => String(e.session_id || '') !== 'unknown');
const execs = all.filter((e) => e.status === 'success' && e.tool_rounds !== null && e.tool_rounds !== undefined);
const uncounted = all.length - execs.length;

const caps = await rows('admin_audit', {
  type: 'and', filters: [{ columnName: 'action', condition: 'eq', value: 'tool_cap_hit' }],
}, 250);

const dist = {};
for (const e of execs) {
  const r = e.tool_rounds === undefined || e.tool_rounds === null ? 'n/a' : String(e.tool_rounds);
  dist[r] = (dist[r] || 0) + 1;
}
const keys = Object.keys(dist).sort();
const total = execs.length;
const maxSeen = Math.max(...keys.filter((k) => k !== 'n/a').map(Number), 0);
const atCap = (dist[String(maxSeen)] || 0);
const capRate = total ? (atCap / total) * 100 : 0;

console.log('多步编排深度仪表 · 近 ' + days + ' 天（已排除探针流量）');
console.log('  成功且带轮次记录: ' + total + '（另有 ' + uncounted + ' 条为错误请求或无轮次数据，不计入）');
console.log('');
console.log('  工具轮次分布:');
for (const k of keys) {
  const n = dist[k];
  const pct = total ? (n / total) * 100 : 0;
  const bar = '#'.repeat(Math.round(pct / 2));
  console.log('    ' + String(k).padStart(4) + ' 轮: ' + String(n).padStart(4) + '  ' + pct.toFixed(1).padStart(5) + '%  ' + bar);
}
console.log('');
console.log('  跑满率（达到观测到的最大轮次 ' + maxSeen + '）: ' + capRate.toFixed(1) + '%');
console.log('  撞顶次数（到达上限仍想调工具）: ' + caps.length);
if (caps.length) {
  console.log('');
  console.log('  最近撞顶明细:');
  for (const c of caps.slice(0, 5)) {
    let d = {};
    try { d = JSON.parse(c.detail || '{}'); } catch (e) {}
    console.log('    round=' + d.round + ' limit=' + d.limit + ' wanted=[' + (d.wanted || []).join(', ') + ']');
  }
}
console.log('');
if (caps.length > 0) {
  console.log('判断：有任务被截断 → 上限确实太紧，提高 MAX_TOOL_ROUNDS 并重跑本脚本。');
} else if (capRate > 20) {
  console.log('判断：跑满率 ' + capRate.toFixed(1) + '% 偏高 → 建议临时设 MAX_TOOL_ROUNDS=5，');
  console.log('      跑几天后再看本脚本的分布，看请求自然停在第几轮。');
} else if (total < 20) {
  console.log('判断：样本太少（' + total + ' 条），还不到下结论的时候。继续用，过几天再看。');
} else {
  console.log('判断：' + capRate.toFixed(1) + '% 跑满、0 次撞顶 → 当前深度够用，不要加深。');
  console.log('      加深只会增加成本、延迟和失控面，换不来完成率。');
}
process.exit(0);
