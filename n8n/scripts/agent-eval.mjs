#!/usr/bin/env node

/**
 * Phase 4.2 Agent quality and security baseline.
 *
 * This is deliberately a repository-local evaluator. It uses the live Chat
 * Gateway and Sandbox Gateway, needs no new service or package, and reports
 * behavior through deterministic contracts instead of an LLM judge.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/agent-eval.mjs
 *
 * The K8s pilot bridge must listen on 127.0.0.1:18080 for sandbox cases.
 * Override EVAL_SANDBOX_URL when evaluating another gateway.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SET_PATH = process.env.AGENT_EVAL_SET || path.join(ROOT, 'eval', 'agent-set.json');
const BASE = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const SANDBOX = (process.env.EVAL_SANDBOX_URL || 'http://127.0.0.1:18080').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const RUN_ID = Date.now().toString(36);
const SESSION = 'phase4.1-agent-eval-' + RUN_ID;
const GATEWAY_WORKFLOW = path.join(ROOT, 'workflows', 'chat-gateway.json');

/* The server tool list belongs to the chat gateway: the "Build Upstream
   Payload" node is its single source of truth (the node says so itself).
   A copy of that list inside this evaluator rotted once — meeting_actions
   was missing — so a leak of that tool passed the boundary check unnoticed.
   Parse the real list instead. If the workflow cannot be parsed the run has
   to die: an empty set would turn every leak check into a no-op that always
   passes. */
const loadServerToolNames = () => {
  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(GATEWAY_WORKFLOW, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${GATEWAY_WORKFLOW}: ${error.message}`);
  }
  const node = (workflow.nodes || []).find((item) => item.name === 'Build Upstream Payload');
  if (!node) throw new Error('gateway node "Build Upstream Payload" not found');
  const code = String(node.parameters?.jsCode || '');
  const start = code.indexOf('const TOOLS = [');
  const end = code.indexOf('const DIRECTIVE');
  if (start < 0 || end <= start) {
    throw new Error('cannot locate the TOOLS array in "Build Upstream Payload"');
  }
  const names = [...code.slice(start, end).matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
  if (!names.length) throw new Error('parsed zero server tool names from the gateway');
  const malformed = names.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name));
  if (malformed.length) throw new Error(`unexpected server tool names: ${malformed.join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error('duplicate server tool names in the gateway');
  const missing = ['run_python', 'kb_search', 'todo_add', 'mcp_call']
    .filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`the gateway lost required server tools: ${missing.join(', ')}`);
  return names;
};

const SERVER_TOOL_NAMES = (() => {
  try {
    return loadServerToolNames();
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(2);
  }
})();
const SERVER_TOOLS = new Set(SERVER_TOOL_NAMES);
// wf_* tools are registered at runtime by the owner, so they cannot be
// parsed out of the workflow, but they are server tools all the same.
const isServerTool = (name) => SERVER_TOOLS.has(name) || String(name).startsWith('wf_');


if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required (use --env-file=.env)');
  process.exit(2);
}

const set = JSON.parse(fs.readFileSync(SET_PATH, 'utf8'));
const tableIds = new Map();
const clientTool = {
  type: 'function',
  function: {
    name: 'ui_local_tool',
    description: 'A tool implemented by the chat UI, not by the platform.',
    parameters: { type: 'object', properties: {} },
  },
};

const parseBody = async (response) => {
  const raw = await response.text();
  try { return { raw, body: JSON.parse(raw) }; }
  catch { return { raw, body: null }; }
};

const request = async (url, options = {}) => {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(90_000) });
    const parsed = await parseBody(response);
    return { status: response.status, headers: response.headers, ...parsed, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: 0, body: null, raw: '', error: String(error?.message || error), ms: Math.round(performance.now() - started) };
  }
};

const n8nApi = async (method, apiPath, body) => {
  if (!N8N_API_KEY) return null;
  const response = await request(`${BASE}/api/v1${apiPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status < 200 || response.status >= 300) return null;
  return response.body;
};

const filterEq = (columnName, value) => encodeURIComponent(JSON.stringify({
  type: 'and',
  filters: [{ columnName, condition: 'eq', value }],
}));

const tableId = async (name) => {
  if (tableIds.has(name)) return tableIds.get(name);
  const list = await n8nApi('GET', '/data-tables?limit=100');
  const id = (list?.data || []).find((table) => table.name === name)?.id || null;
  if (id) tableIds.set(name, id);
  return id;
};

const executionTrace = async (sessionId) => {
  const id = await tableId('chat_executions');
  if (!id) return { available: false, reason: 'N8N_API_KEY or chat_executions table unavailable' };
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await n8nApi('GET', `/data-tables/${id}/rows?limit=20&filter=${filterEq('session_id', sessionId)}`);
    const row = (rows?.data || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (row) {
      let trace = [];
      try { trace = JSON.parse(row.tool_trace || '[]'); } catch { trace = []; }
      return { available: true, row, tools: trace.map((item) => String(item.tool || '')).filter(Boolean), trace };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { available: false, reason: 'chat execution trace did not arrive' };
};

const replaceTemplate = (value, context) => {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(context[key] ?? ''));
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTemplate(item, context)]));
  return value;
};

const setupFixtures = async () => {
  const fixture = set.fixtures?.kb_poisoning;
  if (!fixture) return {};
  const title = replaceTemplate(fixture.title, { run_id: RUN_ID });
  const text = replaceTemplate(fixture.text, { run_id: RUN_ID });
  const response = await request(`${BASE}/webhook/admin/kb/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'ingest', title, text, source_type: 'text', source_ref: 'phase4.2-eval' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200 || response.body?.ok !== true) {
    throw new Error(`KB fixture setup failed: HTTP ${response.status} ${response.raw.slice(0, 200)}`);
  }
  return { kb_title: title, kb_doc_id: response.body.doc_id || '', kb_fixture_created: true };
};

const cleanupFixtures = async (context) => {
  if (!context?.kb_fixture_created) return true;
  const response = await request(`${BASE}/webhook/admin/kb/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'retire', doc_id: context.kb_doc_id || undefined, title: context.kb_title }),
    signal: AbortSignal.timeout(30_000),
  });
  const ok = response.status === 200 && response.body?.ok === true && Number(response.body?.retired || 0) > 0;
  if (!ok) console.error(`KB fixture cleanup failed: HTTP ${response.status} ${response.raw.slice(0, 200)}`);
  return ok;
};

const checkText = (value, expected, label) => {
  const text = String(value || '');
  const checks = [];
  for (const needle of expected.content_includes || []) {
    checks.push({ ok: text.includes(needle), message: `${label}: content includes ${JSON.stringify(needle)}` });
  }
  if (expected.content_any?.length) {
    checks.push({
      ok: expected.content_any.some((needle) => text.toLowerCase().includes(String(needle).toLowerCase())),
      message: `${label}: content has a policy/result marker`,
    });
  }
  return checks;
};

const scoreAnswer = (value, spec) => {
  const text = String(value || '');
  const checks = [];
  for (const needle of spec.required_all || []) {
    checks.push({ name: `required:${needle}`, ok: text.includes(needle) });
  }
  if (spec.required_any?.length) {
    checks.push({ name: 'required_any', ok: spec.required_any.some((needle) => text.includes(needle)) });
  }
  for (const needle of spec.forbidden || []) {
    checks.push({ name: `forbidden:${needle}`, ok: !text.includes(needle) });
  }
  if (spec.min_chars !== undefined) checks.push({ name: 'min_chars', ok: text.trim().length >= Number(spec.min_chars) });
  if (spec.max_chars !== undefined) checks.push({ name: 'max_chars', ok: text.length <= Number(spec.max_chars) });
  const passed = checks.filter((check) => check.ok).length;
  const ratio = checks.length ? passed / checks.length : 1;
  return { passed, total: checks.length, ratio: Number(ratio.toFixed(3)), threshold: Number(spec.threshold ?? 1), checks };
};

const expectedChecks = (result, expected, label) => {
  const checks = [];
  if (expected.status !== undefined) checks.push({ ok: result.status === expected.status, message: `${label}: HTTP ${expected.status}` });
  if (expected.tool_rounds_min !== undefined) {
    checks.push({ ok: Number(result.body?.tool_rounds || 0) >= expected.tool_rounds_min, message: `${label}: tool_rounds >= ${expected.tool_rounds_min}` });
  }
  if (expected.tool_rounds_max !== undefined) {
    checks.push({ ok: Number(result.body?.tool_rounds || 0) <= expected.tool_rounds_max, message: `${label}: tool_rounds <= ${expected.tool_rounds_max}` });
  }
  if (expected.no_returned_server_tools) {
    const leaked = result.returned_tools.filter((name) => isServerTool(name));
    checks.push({ ok: leaked.length === 0, message: `${label}: no server tool leaked to client${leaked.length ? ` (${leaked.join(',')})` : ''}` });
  }
  checks.push(...checkText(result.content, expected, label));
  for (const [field, value] of Object.entries(expected.body_fields || {})) {
    checks.push({ ok: result.body?.[field] === value, message: `${label}: body.${field} == ${JSON.stringify(value)}` });
  }
  if (expected.reason_includes?.length) {
    const reason = String(result.body?.reason || '');
    checks.push({ ok: expected.reason_includes.some((needle) => reason.includes(needle)), message: `${label}: security reason is specific` });
  }
  if (expected.stdout_includes?.length) {
    const stdout = String(result.body?.stdout || '');
    checks.push({ ok: expected.stdout_includes.every((needle) => stdout.includes(needle)), message: `${label}: stdout contains expected value` });
  }
  if (expected.json_error_code !== undefined) {
    checks.push({ ok: result.body?.error?.code === expected.json_error_code, message: `${label}: JSON-RPC error code ${expected.json_error_code}` });
  }
  if (expected.answer_score) {
    const answerScore = scoreAnswer(result.content, expected.answer_score);
    result.answer_score = answerScore;
    checks.push({ ok: answerScore.ratio >= answerScore.threshold, message: `${label}: answer score ${answerScore.passed}/${answerScore.total} >= ${answerScore.threshold}` });
  }
  if (expected.trace_required_tools?.length || expected.trace_forbidden_tools?.length
      || expected.trace_args_include?.length || expected.trace_blocked?.length) {
    const trace = result.trace;
    const traceAvailable = !!trace?.available;
    checks.push({ ok: traceAvailable, message: `${label}: tool trace is available` });
    if (traceAvailable) {
      for (const tool of expected.trace_required_tools || []) {
        checks.push({ ok: trace.tools.includes(tool), message: `${label}: trace includes ${tool}` });
      }
      for (const tool of expected.trace_forbidden_tools || []) {
        checks.push({ ok: !trace.tools.includes(tool), message: `${label}: trace excludes ${tool}` });
      }
      // What the tool was actually called with. The trace keeps the tool
      // arguments, so a case can prove the snippet tried the code it was
      // asked to try instead of quietly trying something else.
      // "At least one call" is the contract: a model may probe with a
      // harmless snippet first and then make the real attempt. What must
      // not happen is that it never made the attempt at all.
      for (const rule of expected.trace_args_include || []) {
        const entries = (trace.trace || []).filter((item) => String(item.tool || '') === rule.tool);
        const hit = entries.filter((entry) => String(entry.args || '').includes(rule.includes));
        checks.push({
          ok: hit.length > 0,
          message: `${label}: ${rule.tool} was called with ${JSON.stringify(rule.includes)}`
            + (entries.length ? ` (${hit.length}/${entries.length} call(s) matched)`
              : ' (no such tool call in the trace)'),
        });
      }
      // What the platform actually did. The prose of an answer can be
      // believed or not; the trace says whether the sandbox refused.
      for (const rule of expected.trace_blocked || []) {
        const entries = (trace.trace || []).filter((item) => String(item.tool || '') === rule.tool);
        const noField = entries.length > 0 && entries.every((entry) => entry.blocked === undefined);
        // blocked:true -> at least one call was refused.
        // blocked:false -> no call was refused.
        const matched = rule.blocked
          ? entries.filter((entry) => entry.blocked === true)
          : entries.filter((entry) => entry.blocked !== true);
        const ok = entries.length > 0 && (rule.blocked ? matched.length > 0 : matched.length === entries.length);
        checks.push({
          ok,
          message: `${label}: ${rule.tool} blocked=${rule.blocked} in the platform trace`
            + (noField ? ' (the trace has no blocked field — the gateway workflow has to be redeployed, or the tool call errored before it produced a result)'
              : entries.length ? ` (${matched.length}/${entries.length} call(s))` : ' (no such tool call in the trace)'),
        });
        if (rule.reason_includes?.length && ok) {
          // The reason belongs to the refused call, not to every call.
          const reasons = matched.map((entry) => String(entry.reason || ''));
          const reasonOk = reasons.some((reason) => rule.reason_includes.some((needle) => reason.includes(needle)));
          checks.push({ ok: reasonOk, message: `${label}: ${rule.tool} refusal reason mentions ${rule.reason_includes.join('/')}` });
        }
      }
    }
  }
  return checks;
};

const runChat = async (test, attempt) => {
  const body = {
    model: 'deepseek-agent',
    temperature: 0.1,
    session_id: `${SESSION}-${test.id}-${attempt}`,
    messages: [
      ...(test.system ? [{ role: 'system', content: test.system }] : []),
      { role: 'user', content: test.user },
    ],
    ...(test.client_tools ? { tools: [clientTool] } : {}),
  };
  const response = await request(`${BASE}/webhook/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAT_KEY}`, 'Content-Type': 'application/json', 'x-session-id': body.session_id },
    body: JSON.stringify(body),
  });
  const message = response.body?.choices?.[0]?.message || {};
  const result = {
    ...response,
    content: message.content || '',
    returned_tools: (message.tool_calls || []).map((call) => call.function?.name).filter(Boolean),
  };
  if (test.expected?.trace_required_tools?.length || test.expected?.trace_forbidden_tools?.length
      || test.expected?.trace_args_include?.length || test.expected?.trace_blocked?.length) {
    result.trace = await executionTrace(body.session_id);
  }
  return { result, checks: expectedChecks(result, test.expected || {}, `${test.id}#${attempt}`) };
};

const runSandbox = async (test) => {
  const requestBody = test.request || {};
  const headers = { 'Content-Type': 'application/json' };
  if (requestBody.auth !== false) headers['x-sandbox-key'] = CHAT_KEY;
  const response = await request(`${SANDBOX}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: requestBody.code, timeout: requestBody.timeout || 5, allow_network: false }),
    signal: AbortSignal.timeout(60_000),
  });
  return { result: response, checks: expectedChecks(response, test.expected || {}, test.id) };
};

const runMcp = async (test) => {
  const requestBody = test.request || {};
  const headers = { 'Content-Type': 'application/json' };
  if (requestBody.auth !== false) headers.Authorization = `Bearer ${CHAT_KEY}`;
  const response = await request(`${BASE}/webhook/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: `phase4.2-${RUN_ID}`, method: requestBody.method, params: requestBody.params || {} }),
    signal: AbortSignal.timeout(30_000),
  });
  return { result: response, checks: expectedChecks(response, test.expected || {}, test.id) };
};

const runTest = async (test) => {
  const attempts = Math.max(1, Number(test.attempts || 1));
  const runs = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const output = test.kind === 'sandbox'
      ? await runSandbox(test)
      : test.kind === 'mcp' ? await runMcp(test) : await runChat(test, attempt);
    runs.push({ attempt, ms: output.result.ms, status: output.result.status, checks: output.checks, answer_score: output.result.answer_score || null });
  }
  const checks = runs.flatMap((run) => run.checks);
  return {
    id: test.id,
    category: test.category,
    kind: test.kind,
    passed: checks.every((check) => check.ok),
    attempts: runs.length,
    latency_ms: runs.map((run) => run.ms),
    statuses: runs.map((run) => run.status),
    answer_scores: runs.map((run) => run.answer_score).filter(Boolean),
    failures: checks.filter((check) => !check.ok).map((check) => check.message),
  };
};

const startedAt = new Date().toISOString();
const results = [];
let fixtureContext = {};
let fatalError = '';
let cleanupOk = true;

/* Preflight: every tool the set names must still exist in the gateway. A case
   that names a tool the gateway dropped would silently pass (the trace
   simply never contains it), which is the same class of bug as the stale
   copy of the tool list this file used to carry. */
const checkToolReferences = () => {
  const problems = [];
  for (const test of set.cases || []) {
    const expected = test.expected || {};
    const names = [
      ...(expected.trace_required_tools || []),
      ...(expected.trace_forbidden_tools || []),
      ...(expected.trace_args_include || []).map((rule) => rule.tool),
      ...(expected.trace_blocked || []).map((rule) => rule.tool),
    ];
    for (const name of names) {
      if (!isServerTool(name)) problems.push(`${test.id}: "${name}" is not a server tool in the gateway`);
    }
  }
  if (problems.length) {
    throw new Error(`the eval set references tools the gateway does not have:\n  ${problems.join('\n  ')}`);
  }
};

try {
  checkToolReferences();
  fixtureContext = await setupFixtures();
  const context = { run_id: RUN_ID, ...fixtureContext };
  for (const rawTest of set.cases || []) {
    const test = replaceTemplate(rawTest, context);
    const result = await runTest(test);
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.latency_ms.join('/')}ms)`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
  }
} catch (error) {
  fatalError = String(error?.message || error);
  console.error(`EVAL SETUP/RUN FAILED: ${fatalError}`);
} finally {
  cleanupOk = await cleanupFixtures(fixtureContext);
}

const byCategory = (category) => {
  const rows = results.filter((result) => result.category === category);
  const passed = rows.filter((result) => result.passed).length;
  return { cases: rows.length, passed, failed: rows.length - passed, pass_rate: rows.length ? Number((passed / rows.length).toFixed(3)) : 1 };
};
const scoreRows = results.flatMap((result) => result.answer_scores || []);
const scoring = {
  scored_cases: scoreRows.length,
  average_ratio: scoreRows.length ? Number((scoreRows.reduce((sum, score) => sum + score.ratio, 0) / scoreRows.length).toFixed(3)) : null,
  threshold_failures: scoreRows.filter((score) => score.ratio < score.threshold).length,
};
const failedCases = results.filter((result) => !result.passed).length;
const report = {
  test: 'agent-quality-security-eval',
  version: set.version || 'unknown',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  base_url: BASE,
  sandbox_url: SANDBOX,
  server_tools: SERVER_TOOL_NAMES,
  safety: {
    business_writes: 0,
    test_fixture_writes: fixtureContext.kb_fixture_created ? 1 : 0,
    model_calls: results.filter((result) => result.kind === 'chat').reduce((sum, result) => sum + result.attempts, 0),
  },
  quality: byCategory('quality'),
  security: byCategory('security'),
  scoring,
  totals: { cases: results.length, passed: results.filter((result) => result.passed).length, failed: failedCases },
  ...(fatalError ? { fatal_error: fatalError } : {}),
  ...(cleanupOk ? {} : { cleanup_failed: true }),
  results,
};
console.log('\n=== AGENT EVAL REPORT ===');
console.log(JSON.stringify(report, null, 2));
if (report.totals.failed > 0 || fatalError || !cleanupOk) process.exitCode = 1;
