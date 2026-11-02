#!/usr/bin/env node
/**
 * A · 项目登记表种子（幂等、非破坏）。
 *
 * `projects` 表由 deploy.mjs 建（它只造结构，从不写数据），行由这里登记。
 * 清单来源：2026-11-03 从 `api.github.com/users/myname173/repos` 抓到的 6 个公开
 * 仓库；`agent-platform` 自己已转私有，不在公开列表里，所以也没被登记。
 * `notes` 只写当天核实到的事实（语言、仓库自述原文），不猜用途；`customer` 一律
 * 留空，由机主自己填——脚本永远不会覆盖一个已经非空的字段，重跑只会补齐空缺。
 *
 * Usage:
 *   N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/seed-projects.mjs         # 只报差异
 *   N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/seed-projects.mjs apply   # 写入
 *
 * Exit code: 0 = 已一致（或写入成功）；1 = 只读模式下发现差异；2 = 调用失败
 */

const N8N_URL = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
const apply = process.argv[2] === 'apply';

if (!N8N_API_KEY) {
  console.error('N8N_API_KEY is required');
  process.exit(2);
}

const ORG = 'myname173';
const FIELDS = ['label', 'repo_url', 'customer', 'status', 'notes'];

const PROJECTS = [
  {
    name: 'my-langgraph-practice',
    label: 'my-langgraph-practice',
    notes: 'Python',
  },
  {
    name: 'fastapi-langgraph-agent',
    label: 'fastapi-langgraph-agent',
    notes: 'Production-ready FastAPI LangGraph agent: SDLC orchestrator, hybrid LLM routing, mem0 long-term memory',
  },
  {
    name: 'xiangshu',
    label: '项述',
    notes: '从 GitHub 仓库与岗位 JD 生成可编译的项目经历 LaTeX / Markdown（TypeScript）',
  },
  {
    name: 'cocos-survivor-game',
    label: 'cocos-survivor-game',
    notes: 'TypeScript',
  },
  {
    name: 'AdAgent-Cocos',
    label: 'AdAgent-Cocos',
    notes: 'Go',
  },
  {
    name: 'GameAgent',
    label: 'GameAgent',
    notes: 'Python',
  },
].map((p) => ({
  name: p.name,
  label: p.label,
  repo_url: `https://github.com/${ORG}/${p.name}`,
  customer: '',
  status: 'active',
  notes: p.notes,
}));

const api = async (method, path, body) => {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

let tableId = null;
try {
  const list = await api('GET', `/data-tables?filter=${encodeURIComponent(JSON.stringify({ name: 'projects' }))}`);
  tableId = list.data?.[0]?.id || null;
} catch (e) {
  console.error(`cannot reach ${N8N_URL}: ${e.message}`);
  process.exit(2);
}

if (!tableId) {
  console.error('projects table missing - run n8n/scripts/deploy.mjs first');
  process.exit(2);
}

let rows = [];
try {
  rows = (await api('GET', `/data-tables/${tableId}/rows?limit=250`)).data || [];
} catch (e) {
  console.error(`cannot read projects rows: ${e.message}`);
  process.exit(2);
}

const byName = new Map(rows.map((r) => [String(r.name || ''), r]));
const toInsert = [];
const toPatch = [];

for (const seed of PROJECTS) {
  const existing = byName.get(seed.name);
  if (!existing) {
    toInsert.push(seed);
    continue;
  }
  /* fill-empty-only: a value the owner already typed wins over the seed */
  const patch = {};
  for (const f of FIELDS) {
    const have = String(existing[f] ?? '').trim();
    const want = String(seed[f] ?? '').trim();
    if (!have && want) patch[f] = want;
  }
  if (Object.keys(patch).length) toPatch.push({ row: existing, patch });
}

const extra = rows.filter((r) => !PROJECTS.some((p) => p.name === String(r.name || '')));

console.log(`${apply ? 'apply' : 'status'} · projects table ${tableId} · ${rows.length} row(s) present`);
for (const p of toInsert) console.log(`  + insert  ${p.name}  (${p.label})`);
for (const { row, patch } of toPatch) {
  console.log(`  ~ fill    ${row.name}  ${Object.keys(patch).join(', ')}`);
}
for (const r of extra) console.log(`  = keep    ${r.name}  (owner-added, not in the seed list)`);
const drift = toInsert.length + toPatch.length;
if (!drift) console.log('  registry already matches the seed list');

if (!apply) {
  process.exit(drift ? 1 : 0);
}

try {
  for (const p of toInsert) {
    await api('POST', `/data-tables/${tableId}/rows`, {
      data: [{ ...p, created_at: new Date().toISOString() }],
    });
  }
  for (const { row, patch } of toPatch) {
    await api('PATCH', `/data-tables/${tableId}/rows/update`, {
      filter: { type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: row.id }] },
      data: patch,
    });
  }
} catch (e) {
  console.error(`write failed: ${e.message}`);
  process.exit(2);
}

const after = (await api('GET', `/data-tables/${tableId}/rows?limit=250`)).data || [];
console.log(`wrote ${toInsert.length} insert(s), ${toPatch.length} fill(s) -> ${after.length} row(s)`);
process.exit(0);
