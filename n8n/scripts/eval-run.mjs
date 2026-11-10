#!/usr/bin/env node
/**
 * Agent shakedown runner. --dry is offline; --preflight only reads the deployment.
 * Live traffic requires --isolated-stack because even a failed security case can
 * mutate business state. This is an operator assertion, not automatic isolation.
 * --deterministic-only explicitly leaves rubric evaluation PENDING.
 *
 * node n8n/scripts/eval-run.mjs --dry --runs 3
 * node --env-file=.env n8n/scripts/eval-run.mjs --preflight
 * node --env-file=<test-env> n8n/scripts/eval-run.mjs --isolated-stack --deterministic-only --record
 *
 * Raw reports/fixtures stay in .eval-local. No truncation, no passing-only sampling.
 * Budget is enforced before the next request; a single in-flight call may overshoot.
 * Actual cost missing => STOP, never silently treat missing telemetry as zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkAttempt, digest, harnessHash, loadSuites, loadTools, positiveInteger, scorecard } from './eval-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PRIVATE = path.join(ROOT, '..', '.eval-local');
export function parseArgs(argv, env = process.env) {
  const opts = {};
  const boolean = new Set(['--dry', '--record', '--preflight', '--isolated-stack', '--deterministic-only']);
  const valued = new Set(['--runs', '--suites', '--report']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (boolean.has(a)) opts[a] = true;
    else if (valued.has(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[a] = argv[++i];
    else throw new Error(`unknown or incomplete option: ${a}`);
  }
  const runs = positiveInteger(opts['--runs'] ?? env.EVAL_RUNS ?? 3, 'runs');
  const budget = Number(env.EVAL_BUDGET_USD ?? 5);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('EVAL_BUDGET_USD must be positive and finite');
  const selected = opts['--suites'] ? opts['--suites'].split(',') : null;
  if (selected?.some((s) => !s)) throw new Error('empty suite selector');
  return { ...opts, runs, budget, selected };
}
export async function apiRequest(base, key, method, apiPath, body) {
  const r = await fetch(`${base}/api/v1${apiPath}`, {
    method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`n8n API HTTP ${r.status}`);
  const j = await r.json();
  if (j === null || typeof j !== 'object' || j.__error === true) throw new Error('invalid n8n API response');
  return j;
}
async function pages(api, prefix) {
  const data = []; const seen = new Set(); let cursor;
  do {
    const page = await api('GET', prefix + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    if (!Array.isArray(page.data)) throw new Error('n8n list response has no data array');
    data.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('invalid/non-advancing cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}
export async function preflight(api) {
  const tables = await pages(api, '/data-tables?limit=100');
  const required = {
    chat_executions: ['session_id', 'client', 'tool_trace', 'cost_usd', 'total_tokens'],
    eval_runs: ['run_id', 'suite_hash', 'report_json', 'tsr', 'pass_k', 'k', 'passed'],
    eval_results: ['run_id', 'case_id', 'attempt', 'passed', 'trace_json'],
  };
  const problems = []; const ids = {};
  for (const [name, columns] of Object.entries(required)) {
    const t = tables.find((t) => t.name === name);
    if (!t) { problems.push(`missing table ${name}`); continue; }
    ids[name] = t.id;
    for (const col of columns) if (!t.columns?.some((c) => c.name === col)) problems.push(`missing column ${name}.${col}`);
  }
  const workflows = await pages(api, '/workflows?limit=100');
  const stats = workflows.find((w) => w.name === 'Chat Stats API');
  if (!stats?.active || !stats.nodes?.some((n) => String(n.parameters?.jsCode || '').includes('const bizRows'))) problems.push('eval traffic isolation is not deployed in active Chat Stats API');
  return { ready: problems.length === 0, problems, ids };
}
export function decodeTraceRow(row) {
  if (!row) return { available: false, reason: 'execution row absent', cost: null, tokens: null };
  let trace;
  try { trace = JSON.parse(row.tool_trace); } catch { trace = null; }
  const valid = Array.isArray(trace) && trace.every((t) => t && typeof t.tool === 'string' && t.tool.length > 0);
  const money = typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) && row.cost_usd >= 0;
  const tokens = typeof row.total_tokens === 'number' && Number.isFinite(row.total_tokens) && row.total_tokens >= 0;
  return { available: valid, trace: valid ? trace : [], cost: money ? row.cost_usd : null, tokens: tokens ? row.total_tokens : null };
}
const eq = (columnName, value) => encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName, condition: 'eq', value }] }));
async function traceFor(api, table, sid) {
  for (let i = 0; i < 8; i++) {
    const j = await api('GET', `/data-tables/${table}/rows?limit=20&sortBy=createdAt%3Adesc&filter=${eq('session_id', sid)}`);
    if (!Array.isArray(j.data)) throw new Error('trace response has no data array');
    const row = j.data.find((r) => r.session_id === sid);
    if (row) return decodeTraceRow(row);
    // Bounded polling of an external asynchronous execution logger.
    if (i < 7) await new Promise((r) => setTimeout(r, 300));
  }
  return decodeTraceRow(null);
}

export async function runConversation(c, attempt, context) {
  const messages = c.system ? [{ role: 'system', content: c.system }] : [];
  const turns = []; const trace = []; let cost = 0; let tokens = 0; let ms = 0;
  let content = ''; let status = 0; let available = true; let stopReason = '';
  for (const [index, turn] of (c.turns || c.messages).entries()) {
    if (context.spent() >= context.budget) { stopReason = 'budget reached before next turn'; break; }
    messages.push(turn);
    // Per-turn session prevents an earlier row being mistaken for the current
    // turn's telemetry. The real assistant history is supplied explicitly.
    const sid = `${context.runId}-${c.id}-${attempt}-turn${index + 1}`;
    const started = performance.now();
    let out;
    try { out = await context.chat(messages, sid, c); }
    catch {
      // The request may already have incurred spend. Keep an UNKNOWN failed
      // attempt rather than dropping it (and earlier successes) from the batch.
      out = { status: 0, content: '', trace: { available: false, trace: [], cost: null, tokens: null }, ms: Math.round(performance.now() - started) };
      stopReason = 'chat/telemetry failure; request outcome unknown';
    }
    status = out.status; content = out.content;
    ms += out.ms;
    const t = out.trace;
    available = available && t?.available === true;
    trace.push(...(t?.trace || []));
    if (Number.isFinite(t?.cost) && t.cost >= 0) { cost += t.cost; context.charge(t.cost); }
    else { cost = null; stopReason = 'missing cost telemetry'; }
    if (tokens !== null && Number.isFinite(t?.tokens) && t.tokens >= 0) tokens += t.tokens; else tokens = null;
    turns.push({ user: turn.content, answer: content, status, session_id: sid, trace: t, ms: out.ms });
    if (stopReason || status !== 200 || !content?.trim() || !available) {
      stopReason ||= status !== 200 ? 'gateway failure' : 'missing answer/trace';
      break;
    }
    messages.push({ role: 'assistant', content });
  }
  const result = { attempt, status, content, trace: { available, trace }, cost, tokens, ms, turns, stop_reason: stopReason || null, tool_rounds: trace.reduce((max, t) => Math.max(max, Number(t.round) || 0), 0) };
  const checks = checkAttempt(result, c, { deterministicOnly: context.deterministicOnly });
  return { ...result, checks, passed: checks.every((c) => c.ok) };
}
export function privateOutput(file, root = PRIVATE) {
  const target = path.resolve(file); const base = path.resolve(root);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('raw reports must stay inside .eval-local; redact separately before publication');
  for (let p = path.dirname(target); p.length >= base.length; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('raw report directory must not be a symlink');
    if (p === base || path.dirname(p) === p) break;
  }
  return target;
}
export function runFailed(report) {
  return !report.complete || !!report.stopped_reason || report.results.some((r) => r.attempts.some((a) => a.passed !== true));
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}
async function persist(api, ids, report) {
  const { results, ...summary } = report;
  // Do not slice JSON strings: a truncated JSON blob is not a recoverable report.
  const runRow = {
    run_id: report.run_id, suite: 'mixed', suite_hash: report.suite_hash,
    git_commit: process.env.GIT_COMMIT || '', model: report.model, judge_model: '',
    started_at: report.started_at, finished_at: report.finished_at,
    cases: report.totals.cases, passed: results.filter((r) => r.attempts.length === report.runs && r.attempts.every((a) => a.passed)).length,
    tsr: report.totals.tsr, pass_k: report.totals.pass_k, k: report.runs,
    p50_ms: report.latency_ms.p50, p95_ms: report.latency_ms.p95,
    cost_usd: report.cost_usd, safety_violations: report.safety_violations,
    report_json: JSON.stringify(summary),
  };
  const rows = results.flatMap((r) => r.attempts.map((a) => ({
    run_id: report.run_id, case_id: r.case_id, category: r.category, attempt: a.attempt,
    passed: a.passed ? 1 : 0, score: null, latency_ms: a.ms, tokens: a.tokens,
    cost_usd: a.cost, tool_rounds: a.tool_rounds,
    failures: JSON.stringify(a.checks.filter((c) => !c.ok)), trace_json: JSON.stringify(a.trace.trace),
  })));
  for (let i = 0; i < rows.length; i += 100) await api('POST', `/data-tables/${ids.eval_results}/rows`, { data: rows.slice(i, i + 100) });
  await api('POST', `/data-tables/${ids.eval_runs}/rows`, { data: [runRow] });
  const readRuns = await pages(api, `/data-tables/${ids.eval_runs}/rows?limit=100&filter=${eq('run_id', report.run_id)}`);
  const readResults = await pages(api, `/data-tables/${ids.eval_results}/rows?limit=100&filter=${eq('run_id', report.run_id)}`);
  const rr = readRuns.filter((r) => r.run_id === report.run_id);
  const ar = readResults.filter((r) => r.run_id === report.run_id);
  const actual = new Map(ar.map((r) => [`${r.case_id}:${r.attempt}`, r]));
  if (rr.length !== 1 || rr[0].suite_hash !== report.suite_hash || rr[0].report_json !== runRow.report_json || ar.length !== rows.length || actual.size !== rows.length || rows.some((r) => {
    const a = actual.get(`${r.case_id}:${r.attempt}`);
    return !a || a.passed !== r.passed || a.trace_json !== r.trace_json;
  })) throw new Error('persistence read-back mismatch; do not rerun blindly (partial writes possible)');
  return { eval_runs: true, eval_results: true, verified_rows: ar.length };
}
export async function main(argv = process.argv.slice(2), env = process.env, { privateDir = PRIVATE } = {}) {
  const options = parseArgs(argv, env);
  if (options['--report']) privateOutput(options['--report'], privateDir);
  const tools = loadTools(path.join(ROOT, 'workflows', 'chat-gateway.json'));
  const { cases, suiteHash } = loadSuites(path.join(ROOT, 'eval', 'suites'), tools, options.selected);
  const hash = harnessHash(import.meta.dirname);
  const plan = {
    cases: cases.length, runs: options.runs, planned_attempts: cases.length * options.runs,
    gateway_requests: cases.reduce((n, c) => n + (c.turns || c.messages).length * options.runs, 0),
    model_calls: 'unknown: gateway may make several model calls per request',
    budget_usd: options.budget, budget_limit: 'stop before next request; one in-flight request may overshoot',
    suite_hash: suiteHash, harness_hash: hash,
    pending_judge_cases: cases.filter((c) => c.expect.judge).length,
    state_assertions: 'not implemented; tool-call traces are NOT final database state proof',
  };
  if (options['--dry']) { console.log(JSON.stringify({ mode: 'dry', ...plan }, null, 2)); return 0; }
  if (!env.N8N_API_KEY) throw new Error('N8N_API_KEY required');
  const base = (env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
  const api = (method, p, b) => apiRequest(base, env.N8N_API_KEY, method, p, b);
  if (options['--preflight']) {
    const p = await preflight(api);
    console.log(JSON.stringify({ mode: 'read-only-preflight', ready: p.ready, problems: p.problems, ...plan }, null, 2));
    return p.ready ? 0 : 2;
  }
  if (!options['--isolated-stack']) throw new Error('live eval refused: --isolated-stack required; cases can create/cancel real records');
  if (!options['--deterministic-only'] && plan.pending_judge_cases) throw new Error('judge calibration is pending; use --deterministic-only for shakedown, not release acceptance');
  if (!env.CHAT_API_KEY) throw new Error('CHAT_API_KEY required');
  const p = await preflight(api);
  if (!p.ready) throw new Error(p.problems.join('; '));
  const runId = `eval-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  let spent = 0; let stopped = ''; const results = [];
  const context = {
    runId, budget: options.budget, spent: () => spent, charge: (n) => { spent += n; },
    deterministicOnly: !!options['--deterministic-only'],
    chat: async (messages, sid, c) => {
      const started = performance.now();
      let status = 0; let content = '';
      try {
        const r = await fetch(`${base}/webhook/v1/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${env.CHAT_API_KEY}`, 'Content-Type': 'application/json', 'x-session-id': sid, 'x-client': 'eval', 'x-eval-suite': c.suite },
          body: JSON.stringify({ model: c.model || env.EVAL_MODEL || 'deepseek-agent', temperature: .1, session_id: sid, messages }), signal: AbortSignal.timeout(120000),
        });
        status = r.status;
        const b = await r.json().catch(() => null);
        content = b?.choices?.[0]?.message?.content || '';
      } catch { /* status zero is an observable failure, never a fake success */ }
      const trace = await traceFor(api, p.ids.chat_executions, sid);
      return { status, content, trace, ms: Math.round(performance.now() - started) };
    },
  };
  try {
    for (const c of cases) {
      const row = { case_id: c.id, category: c.category, attempts: [] };
      results.push(row);
      for (let i = 1; i <= options.runs; i++) {
        if (spent >= options.budget) { stopped = 'budget reached'; break; }
        const a = await runConversation(c, i, context);
        row.attempts.push(a);
        console.log(`${a.passed ? 'PASS' : 'FAIL'} ${c.id}#${i}`);
        if (a.stop_reason) { stopped = a.stop_reason; break; }
      }
      if (options['--record'] && row.attempts.length) writeJson(privateOutput(path.join(privateDir, 'replay', runId, `${c.id}.json`), privateDir), {
        schema_version: 2, source: 'live', run_id: runId, recorded_at: new Date().toISOString(),
        case_id: c.id, case_hash: digest(c), suite_hash: suiteHash, harness_hash: hash, runs: options.runs,
        evaluation_scope: 'deterministic-shakedown', attempts: row.attempts,
      });
      if (stopped) break;
    }
  } catch (e) { stopped = `execution error: ${e.message}`; }
  const report = {
    test: 'eval-runner', run_id: runId, suite_hash: suiteHash, harness_hash: hash,
    model: env.EVAL_MODEL || 'deepseek-agent', started_at: startedAt, finished_at: new Date().toISOString(), runs: options.runs,
    evaluation_scope: 'deterministic-shakedown', release_ready: false,
    judge_pending: plan.pending_judge_cases, state_assertions: plan.state_assertions,
    stopped_reason: stopped || null, ...scorecard(results, cases.length, options.runs), results,
  };
  const outFile = privateOutput(options['--report'] || path.join(privateDir, 'reports', `${runId}.json`), privateDir);
  writeJson(outFile, report); // save evidence even if persistence is unavailable
  let persistFailed = false;
  try { report.persisted = await persist(api, p.ids, report); }
  catch (e) { persistFailed = true; report.persisted = { verified: false, reason: e.message }; }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ run_id: runId, ...report.totals, stopped_reason: report.stopped_reason, persisted: report.persisted, report: outFile, release_ready: false }, null, 2));
  return persistFailed || runFailed(report) ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (e) { console.error(`EVAL SETUP FAILED: ${e.message}`); process.exitCode = 2; }
}
