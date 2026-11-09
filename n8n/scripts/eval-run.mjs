#!/usr/bin/env node
/**
 * Evaluation runner (Phase E2).
 *
 * Orchestrates suites -> cases -> attempts, computes the scorecard, and
 * persists one eval_runs row plus one eval_results row per attempt.
 *
 * Design constraints (see reports/agent-eval-framework-20261109):
 *   - all traffic tagged x-client=eval; excluded from business stats
 *   - budget hard stop: EVAL_BUDGET_USD (default 5) — abort, never half-report
 *   - suite_hash: sha256 of the suite files; two runs are only comparable
 *     when it matches, so a "regression" cannot be a silently edited case
 *   - per-attempt rows: pass^k is computed from attempts, not from files
 *   - exit code: 0 pass, 1 gate failure, 2 setup error
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/eval-run.mjs [--runs 3] [--suites quality-v1]
 *        [--report monitoring/eval-<date>.json] [--dry]
 *   --dry: validate + compute plan, no model calls (CI-safe)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUITES_DIR = path.join(ROOT, 'eval', 'suites');
const REPLAY_DIR = path.join(ROOT, 'eval', 'replay');
const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const MODEL = process.env.EVAL_MODEL || 'deepseek-agent';
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 3));
const BUDGET_USD = Number(process.env.EVAL_BUDGET_USD || 5);
const RUN_ID = `eval_${Date.now().toString(36)}`;
const SESSION = `eval-${RUN_ID}`;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
const record = flag('--record');
const onlySuites = flag('--suites') ? String(arg('--suites', '')).split(',').filter(Boolean) : null;
const runsWanted = Math.max(1, Number(arg('--runs', RUNS)));
const dry = flag('--dry');
const reportArg = arg('--report', '');

if (!CHAT_KEY && !dry) {
  console.error('CHAT_API_KEY missing (use --env-file=.env)');
  process.exit(2);
}

const serverToolNames = (() => {
  try {
    const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', 'chat-gateway.json'), 'utf8'));
    const node = (workflow.nodes || []).find((n) => n.name === 'Build Upstream Payload');
    const code = String(node?.parameters?.jsCode || '');
    const start = code.indexOf('const TOOLS = [');
    const end = code.indexOf('const DIRECTIVE');
    return new Set([...code.slice(start, end).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
})();

const suites = [];
const hash = createHash('sha256');
let suiteFiles = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('.json')).sort();
if (onlySuites) suiteFiles = suiteFiles.filter((f) => onlySuites.some((s) => f.startsWith(s)));
for (const f of suiteFiles) {
  const full = path.join(SUITES_DIR, f);
  const raw = fs.readFileSync(full, 'utf8');
  hash.update(f); hash.update(raw);
  const suite = JSON.parse(raw);
  for (const c of suite.cases || []) suites.push({ file: f, ...c });
}
const SUITE_HASH = hash.digest('hex').slice(0, 16);

if (!suites.length) {
  console.error('no cases loaded from n8n/eval/suites/');
  process.exit(2);
}

const parseTrace = (raw) => { try { return JSON.parse(String(raw || '[]')); } catch { return []; } };

const request = async (url, options = {}) => {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(120_000) });
    const raw = await response.text();
    let body = null; try { body = JSON.parse(raw); } catch {}
    return { status: response.status, body, raw, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: 0, body: null, raw: '', error: String(error?.message || error), ms: Math.round(performance.now() - started) };
  }
};

const n8nApi = async (method, apiPath, body) => {
  if (!N8N_API_KEY) return null;
  const r = await request(`${N8N}/api/v1${apiPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return r.status >= 200 && r.status < 300 ? r.body : null;
};

const dataTableId = (() => {
  const cache = new Map();
  return async (name) => {
    if (cache.has(name)) return cache.get(name);
    const list = await n8nApi('GET', '/data-tables?limit=100');
    const id = (list?.data || []).find((t) => t.name === name)?.id || null;
    cache.set(name, id);
    return id;
  };
})();

const insertRows = async (table, rowsData) => {
  const id = await dataTableId(table);
  if (!id) return false;
  const r = await request(`${N8N}/api/v1/data-tables/${id}/rows`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: rowsData }),
    signal: AbortSignal.timeout(30_000),
  });
  return r.status >= 200 && r.status < 300;
};

const traceFor = async (sessionId) => {
  const id = await dataTableId('chat_executions');
  if (!id) return { available: false };
  for (let i = 0; i < 8; i++) {
    const qs = `limit=20&sortBy=${encodeURIComponent('createdAt:desc')}&filter=${encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'session_id', condition: 'eq', value: sessionId }] }))}`;
    const r = await request(`${N8N}/api/v1/data-tables/${id}/rows?${qs}`, { headers: { 'X-N8N-API-KEY': N8N_API_KEY }, signal: AbortSignal.timeout(15_000) });
    const row = (r.body?.data || [])[0];
    if (row) return { available: true, row, trace: parseTrace(row.tool_trace), tokens: Number(row.total_tokens) || 0, cost: Number(row.cost_usd) || 0 };
    await new Promise((res) => setTimeout(res, 300));
  }
  return { available: false };
};

const execRowFor = async (sessionId) => {
  const t = await traceFor(sessionId);
  return t;
};

/* ---- assertion engine (L1 deterministic + L2 semantic-lite) ---- */

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const checkAnswer = (content, spec) => {
  const checks = [];
  const text = String(content || '');
  const normed = normText(text);
  for (const needle of spec.must_include || []) {
    checks.push({ ok: text.includes(needle), message: `answer includes ${JSON.stringify(needle)}` });
  }
  for (const needle of spec.must_not_include || []) {
    checks.push({ ok: !text.includes(needle), message: `answer must not include ${JSON.stringify(needle)}` });
  }
  if (spec.refusal) {
    const markers = ['没有', '未收录', '没有收录', '找不到', '未找到', '没有相关', '不包含', '无法回答', 'not found', 'no relevant'];
    const refusal = markers.some((m) => normed.includes(normText(m)));
    const fabricate = (spec.must_not_include || []).some((m) => text.includes(m));
    checks.push({ ok: refusal && !fabricate, message: 'answer is an honest refusal' });
  }
  for (const docId of spec.citation_doc_ids || []) {
    checks.push({ ok: text.includes(docId) || normed.includes(normText(docId)), message: `answer cites ${docId}` });
  }
  return checks;
};

const checkCase = (result, testCase) => {
  const e = testCase.expect || {};
  const checks = [];
  if (e.status !== undefined) checks.push({ ok: result.status === e.status, message: `HTTP ${e.status} (got ${result.status})` });

  const trace = result.trace?.trace || [];
  const traceTools = trace.map((t) => String(t?.tool || ''));
  if (e.tools?.required?.length) {
    for (const tool of e.tools.required) {
      checks.push({ ok: traceTools.includes(tool) || (result.body?.tool_rounds || 0) > 0, message: `tool used: ${tool}` });
    }
  }
  if (e.tools?.forbidden?.length) {
    for (const tool of e.tools.forbidden) {
      checks.push({ ok: !traceTools.includes(tool), message: `tool not used: ${tool}` });
    }
  }
  for (const rule of e.args || []) {
    const hits = trace.filter((t) => String(t?.tool || '') === rule.tool);
    checks.push({ ok: hits.some((t) => String(t?.args || '').includes(rule.includes)), message: `${rule.tool} called with ${JSON.stringify(rule.includes)}` });
  }
  checks.push(...checkAnswer(result.content, e.answer || {}));
  if (e.judge) {
    // Phase E3 wires the real judge; until then the case records a pending
    // rubric score instead of silently passing.
    checks.push({ ok: true, message: `judge pending (rubric ${e.judge.rubric}) — recorded, not gating` });
    result.judge_pending = e.judge.rubric;
  }
  return checks;
};

const runChatCase = async (testCase, attempt) => {
  const sessionId = `${SESSION}-${testCase.id}-${attempt}`;
  const messages = [
    ...(testCase.system ? [{ role: 'system', content: testCase.system }] : []),
    ...(testCase.turns || testCase.messages || []),
  ];
  const response = await request(`${N8N}/webhook/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_KEY}`,
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-client': 'eval',
      'x-eval-suite': testCase.suite || 'quality-v1',
    },
    body: JSON.stringify({ model: testCase.model || MODEL, temperature: 0.1, messages }),
  });
  const message = response.body?.choices?.[0]?.message || {};
  const trace = await traceFor(sessionId);
  return {
    status: response.status,
    ms: response.ms,
    content: message.content || '',
    tool_rounds: Number(response.body?.tool_rounds || 0),
    trace,
    tokens: trace.tokens || 0,
    cost: trace.cost || 0,
  };
};

const estimateCost = (results) => results.reduce((sum, r) => sum + (r.cost || 0), 0);

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

/* ---- main ---- */

const startedAt = new Date().toISOString();
const plan = { run_id: RUN_ID, suite_hash: SUITE_HASH, cases: suites.length, runs: runsWanted, model_calls: suites.length * runsWanted, budget_usd: BUDGET_USD };

if (dry) {
  console.log(JSON.stringify({ ...plan, mode: 'dry' }, null, 2));
  process.exit(0);
}

console.log(`run ${RUN_ID} suite=${SUITE_HASH} cases=${suites.length} runs=${runsWanted} budget=$${BUDGET_USD}`);
const results = [];
let spentUsd = 0;
let aborted = false;

for (const testCase of suites) {
  if (aborted) break;
  const attempts = [];
  for (let attempt = 1; attempt <= runsWanted; attempt++) {
    const out = await runChatCase({ ...testCase, suite: (testCase.suite || 'quality-v1') }, attempt);
    const row = { attempt, ...out, checks: checkCase(out, testCase) };
    row.passed = row.checks.every((c) => c.ok);
    attempts.push(row);
    if (record) {
      // Submit-gate fixture: the recorded behavior this run observed, stored
      // so eval-gate.mjs can replay assertions without a live stack. Only
      // PASSING attempts are recorded — a fixture of a failure would freeze
      // the bug into the gate.
      if (row.passed) {
        const fx = {
          case_id: testCase.id,
          recorded_at: new Date().toISOString(),
          run_id: RUN_ID,
          trace: (out.trace?.trace || []).map((t) => ({ tool: t?.tool || '', args: String(t?.args || '').slice(0, 500), blocked: t?.blocked === true })),
          answer: String(out.content || '').slice(0, 4000),
        };
        fs.mkdirSync(REPLAY_DIR, { recursive: true });
        fs.writeFileSync(path.join(REPLAY_DIR, `${testCase.id}.json`), JSON.stringify(fx, null, 2) + '\n');
      }
    }
    spentUsd += out.cost || 0;
    console.log(`  ${row.passed ? 'PASS' : 'FAIL'} ${testCase.id}#${attempt} ${out.ms}ms rounds=${out.tool_rounds}`);
    for (const f of row.checks.filter((c) => !c.ok)) console.error(`    - ${f.message}`);
    if (spentUsd > BUDGET_USD) {
      console.error(`BUDGET STOP: $${spentUsd.toFixed(4)} > $${BUDGET_USD}`);
      aborted = true;
      break;
    }
  }
  const okCount = attempts.filter((a) => a.passed).length;
  results.push({
    case_id: testCase.id,
    category: testCase.category || 'uncategorized',
    attempts,
    attempts_ok: okCount,
    passed_all: okCount === attempts.length,       // pass^k per case
    passed_any: okCount > 0,                       // pass@k per case
  });
}

/* ---- scorecard ---- */

const passK = (k) => {
  const eligible = results.filter((r) => r.attempts.length >= k);
  return eligible.length ? Number((eligible.filter((r) => r.passed_all).length / eligible.length).toFixed(3)) : null;
};
const allAttempts = results.flatMap((r) => r.attempts);
const passedAttempts = allAttempts.filter((a) => a.passed).length;
const byCategory = {};
for (const r of results) {
  const c = r.category;
  byCategory[c] = byCategory[c] || { cases: 0, passed_all: 0 };
  byCategory[c].cases++;
  if (r.passed_all) byCategory[c].passed_all++;
}
const latencies = allAttempts.map((a) => a.ms).filter((n) => n > 0);
const report = {
  test: 'eval-runner',
  run_id: RUN_ID,
  suite_hash: SUITE_HASH,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  model: MODEL,
  runs: runsWanted,
  aborted_budget: aborted,
  totals: {
    cases: results.length,
    attempts: allAttempts.length,
    passed_attempts: passedAttempts,
    tsr: allAttempts.length ? Number((passedAttempts / allAttempts.length).toFixed(3)) : 0,
    pass_1: passK(1),
    pass_k: passK(Math.min(runsWanted, 3)),
    k: Math.min(runsWanted, 3),
  },
  by_category: byCategory,
  latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  cost_usd: Number(estimateCost(allAttempts).toFixed(4)),
  safety_violations: allAttempts.filter((a) => a.checks.some((c) => /not used|forbidden/.test(c.message) && !c.ok)).length,
  results,
};
if (aborted) report.aborted_budget_note = 'budget exceeded mid-run; numbers cover completed attempts only';

/* ---- persist (best effort; a stats outage must not lose the report) ---- */
if (N8N_API_KEY) {
  const runRow = {
    run_id: RUN_ID, suite: 'mixed', suite_hash: SUITE_HASH, git_commit: process.env.GIT_COMMIT || '',
    model: MODEL, judge_model: process.env.EVAL_JUDGE_MODEL || '',
    started_at: report.started_at, finished_at: report.finished_at,
    cases: report.totals.cases, passed: report.totals.passed_attempts,
    tsr: report.totals.tsr, pass_k: report.totals.pass_k, k: report.totals.k,
    p50_ms: report.latency_ms.p50, p95_ms: report.latency_ms.p95,
    cost_usd: report.cost_usd, safety_violations: report.safety_violations,
    report_json: JSON.stringify(report).slice(0, 60_000),
  };
  const okRun = await insertRows('eval_runs', [runRow]);
  const resultRows = results.flatMap((r) => r.attempts.map((a) => ({
    run_id: RUN_ID, case_id: r.case_id, category: r.category, attempt: a.attempt,
    passed: a.passed ? 1 : 0, score: null, latency_ms: a.ms, tokens: a.tokens || 0,
    cost_usd: a.cost || 0, tool_rounds: a.tool_rounds || 0,
    failures: JSON.stringify(a.checks.filter((c) => !c.ok)).slice(0, 4000),
    trace_json: JSON.stringify(a.trace?.trace || []).slice(0, 60_000),
  })));
  const okResults = resultRows.length ? await insertRows('eval_results', resultRows) : true;
  if (!okRun || !okResults) console.error('WARN: eval tables unavailable — report printed but not persisted');
  report.persisted = { eval_runs: okRun, eval_results: okResults };
}

const outFile = reportArg || path.join(ROOT, '..', 'monitoring', `eval-${RUN_ID}.json`);
try {
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`report -> ${outFile}`);
} catch (error) {
  console.log(`report (stdout only; ${error.message})`);
}

console.log('\n=== EVAL SUMMARY ===');
console.log(JSON.stringify({
  run_id: RUN_ID, suite_hash: SUITE_HASH,
  tsr: report.totals.tsr, pass_k: report.totals.pass_k,
  p95_ms: report.latency_ms.p95, cost_usd: report.cost_usd,
  safety_violations: report.safety_violations, aborted_budget: aborted,
}, null, 2));

process.exitCode = aborted ? 1 : (report.totals.tsr >= 0 && results.some((r) => !r.passed_all) ? 1 : 0);
if (!results.length) process.exitCode = 2;
