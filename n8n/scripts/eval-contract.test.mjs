import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCase, digest, loadSuites, loadTools, replayFixture, scorecard, validateCase } from './eval-contract.mjs';
import { decodeTraceRow, main, parseArgs, preflight, privateOutput, runConversation, runFailed } from './eval-run.mjs';
import { replayAll } from './eval-gate.mjs';

const tools = new Set(['kb_search', 'todo_add']);
const sample = () => ({ id: 'case_1', category: 'kb', kind: 'chat', origin: 'boundary', turns: [{ role: 'user', content: '查资料' }], expect: { status: 200, tools: { required: ['kb_search'], forbidden: ['todo_add'] }, answer: { must_include: ['结论'], max_chars: 20 } } });
const observation = () => ({ status: 200, content: '结论', trace: { available: true, trace: [{ tool: 'kb_search', args: '{"query":"资料"}' }] }, turns: [{ status: 200, answer: '结论', trace: { available: true, trace: [{ tool: 'kb_search', args: '{"query":"资料"}' }], cost: .001 } }], cost: .001, tokens: 1, ms: 10 });
const passes = (r, c = sample()) => checkCase(r, c, { deterministicOnly: true }).every((v) => v.ok);
const temp = (t) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-contract-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };

test('positive control: real matching tool trace passes', () => assert.equal(passes(observation()), true));
test('negative control: nonzero tool_rounds is not proof of the required tool', () => {
  const r = observation(); r.trace.trace = [{ tool: 'todo_add' }]; r.body = { tool_rounds: 2 };
  assert.equal(passes(r), false);
});
test('missing trace cannot pass a forbidden-tools-only case', () => {
  const c = sample(); c.expect.tools = { forbidden: ['todo_add'] };
  assert.equal(passes({ ...observation(), trace: { available: false } }, c), false);
});
test('malformed trace and missing cost remain unknown, while genuine empty trace is valid', () => {
  assert.equal(decodeTraceRow({ tool_trace: '{oops', cost_usd: 0 }).available, false);
  assert.equal(decodeTraceRow({ tool_trace: '{}', cost_usd: 0 }).available, false);
  const t = decodeTraceRow({ tool_trace: '[]', cost_usd: 0, total_tokens: 0 });
  assert.equal(t.available, true); assert.equal(t.cost, 0);
  assert.equal(decodeTraceRow({ tool_trace: '[]' }).cost, null);
});
test('empty 200 response cannot pass forbidden-word checks', () => assert.equal(passes({ ...observation(), content: '' }), false));
test('length, argument, refusal and citation checks are actually implemented', () => {
  const c = sample(); c.expect.args = [{ tool: 'kb_search', includes: '资料' }];
  c.expect.answer = { min_chars: 2, max_chars: 12, refusal: true, citation_doc_ids: ['文档A'] };
  assert.equal(passes({ ...observation(), content: '未收录，来源文档A' }, c), true);
  for (const content of ['未', '有相关内容文档A', '未收录', '未收录，但这是一个超出十二字符的很长回答文档A']) assert.equal(passes({ ...observation(), content }, c), false);
  const r = observation(); r.trace.trace[0].args = '{}'; r.content = '未收录，来源文档A';
  assert.equal(passes(r, c), false);
});
test('pending judge does not silently pass; deterministic-only is explicit', () => {
  const c = sample(); c.expect.judge = { rubric: 'grounded-v1', threshold: .75 };
  assert.equal(checkCase(observation(), c).every((v) => v.ok), false);
  assert.equal(passes(observation(), c), true);
});
for (const [name, modify] of [
  ['unsupported protocol', (c) => { c.kind = 'sandbox'; }],
  ['unimplemented assertion', (c) => { c.expect.trace_blocked = []; }],
  ['empty decorative answer', (c) => { c.expect = { answer: {} }; }],
  ['judge-only case', (c) => { c.expect = { judge: { rubric: 'v1', threshold: .75 } }; }],
  ['unknown tool', (c) => { c.expect.tools.required = ['imaginary']; }],
  ['empty args substring', (c) => { c.expect.args = [{ tool: 'kb_search', includes: '' }]; }],
  ['path traversal id', (c) => { c.id = '../out'; }],
  ['real failure without triage', (c) => { c.origin = 'real-failure'; }],
  ['fake assistant turn', (c) => { c.turns.push({ role: 'assistant', content: 'invented success' }); }],
]) test(`validator rejects ${name}`, () => { const c = sample(); modify(c); assert.ok(validateCase(c, tools).length > 0); });
test('validator positive control and exact suite selection', (t) => {
  assert.deepEqual(validateCase(sample(), tools), []);
  const dir = temp(t); fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({ cases: [sample()] }));
  assert.equal(loadSuites(dir, tools, ['one']).cases.length, 1);
  assert.throws(() => loadSuites(dir, tools, ['on']), /unknown suite/);
  fs.writeFileSync(path.join(dir, 'two.json'), JSON.stringify({ cases: [sample()] }));
  assert.throws(() => loadSuites(dir, tools), /duplicate/);
});
for (const value of ['NaN', '0', '-1', '1.2', 'Infinity']) test(`CLI rejects invalid runs ${value}`, () => assert.throws(() => parseArgs(['--dry', '--runs', value], {})));
test('CLI rejects missing values, unknown flags and NaN budget', () => {
  assert.throws(() => parseArgs(['--runs'], {}));
  assert.throws(() => parseArgs(['--wat'], {}));
  assert.throws(() => parseArgs([], { EVAL_BUDGET_USD: 'NaN' }));
});
test('pass_1 / pass^k / pass@k have separate denominators', () => {
  const rows = [[true, false, true], [true, true, true], [false, false, false]].map((arr) => ({ attempts: arr.map((passed) => ({ passed, ms: 10, cost: .1 })) }));
  const r = scorecard(rows, 3, 3);
  assert.equal(r.totals.pass_1, .6667); assert.equal(r.totals.pass_k, .3333); assert.equal(r.totals.pass_at_k, .6667); assert.equal(r.totals.tsr, .5556);
});
test('partial budget-stopped run has no comparable baseline metrics', () => {
  const r = scorecard([{ attempts: [{ passed: true, ms: 1, cost: 1 }] }], 26, 3);
  assert.equal(r.complete, false); assert.equal(r.totals.pass_k, null); assert.equal(r.totals.tsr, null); assert.equal(r.totals.observed_tsr, 1);
});
const fixture = (c) => ({ schema_version: 2, source: 'live', case_id: c.id, case_hash: digest(c), suite_hash: 'suite', harness_hash: 'harness', runs: 3, attempts: [observation(), observation(), observation()] });
test('replay positive control, stale versions and failed repetitions', () => {
  const c = sample(); const fx = fixture(c);
  assert.deepEqual(replayFixture(fx, c, 'suite', 'harness', 3), []);
  for (const key of ['case_hash', 'suite_hash', 'harness_hash']) assert.ok(replayFixture({ ...fx, [key]: 'old' }, c, 'suite', 'harness', 3).length);
  assert.ok(replayFixture({ ...fx, attempts: fx.attempts.slice(0, 1) }, c, 'suite', 'harness', 3).length);
  fx.attempts[1].status = 500;
  assert.ok(replayFixture(fx, c, 'suite', 'harness', 3).some((e) => e.includes('HTTP')));
});
test('one fixture out of two cannot turn the gate green', (t) => {
  const c = sample(); const dir = temp(t);
  fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(fixture(c)));
  const result = replayAll({ cases: [c, { ...c, id: 'case_2' }], suiteHash: 'suite', hash: 'harness', dir, runs: 3 });
  assert.equal(result.replayed, 1); assert.equal(result.errors.length, 1);
});
test('conversation sends actual assistant answer before the next user turn', async () => {
  const c = sample(); c.turns.push({ role: 'user', content: '再解释一下' });
  let spent = 0; const calls = [];
  const a = await runConversation(c, 1, { runId: 'unit', budget: 1, spent: () => spent, charge: (n) => { spent += n; }, deterministicOnly: true,
    chat: async (messages, sid) => { calls.push({ messages: structuredClone(messages), sid }); return { ...observation(), trace: { ...observation().trace, cost: .01, tokens: 2 } }; },
  });
  assert.equal(a.passed, true); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(calls[1].messages[1].content, '结论'); assert.notEqual(calls[0].sid, calls[1].sid);
  assert.equal(a.cost, .02);
});
test('missing cost stops the conversation before the second request', async () => {
  const c = sample(); c.turns.push({ role: 'user', content: '继续' }); let calls = 0;
  const a = await runConversation(c, 1, { runId: 'unit', budget: 1, spent: () => 0, charge: () => {}, deterministicOnly: true,
    chat: async () => { calls++; return { ...observation(), trace: { ...observation().trace, cost: null } }; },
  });
  assert.equal(calls, 1); assert.equal(a.passed, false); assert.equal(a.cost, null);
});
test('budget is checked between turns, not only between cases', async () => {
  const c = sample(); c.turns.push({ role: 'user', content: '继续' }); let spent = 0; let calls = 0;
  const a = await runConversation(c, 1, { runId: 'unit', budget: .01, spent: () => spent, charge: (n) => { spent += n; }, deterministicOnly: true,
    chat: async () => { calls++; return { ...observation(), trace: { ...observation().trace, cost: .01 } }; },
  });
  assert.equal(calls, 1); assert.equal(a.passed, false); assert.match(a.stop_reason, /budget/);
});
test('deployment preflight fails for missing tables and undeployed stats', async () => {
  const calls = [];
  const p = await preflight(async (method, p) => { calls.push(method); return { data: [], nextCursor: null }; });
  assert.equal(p.ready, false); assert.equal(p.problems.length, 4); assert.ok(calls.every((m) => m === 'GET'));
});
test('unsafe live execution refuses before any network call', async (t) => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not call'); });
  await assert.rejects(() => main([], { N8N_API_KEY: 'offline-placeholder' }), /isolated-stack/);
  assert.equal(calls, 0);
});

// Explicit synthetic transport integration. These observations are NOT model
// fixtures and are never written to n8n/eval/replay or used as live evidence.
function fakeDeployment(t, { loseWrite = false, traceFailureAfter = Infinity } = {}) {
  const tables = Object.entries({ chat_executions: ['session_id', 'client', 'tool_trace', 'cost_usd', 'total_tokens'], eval_runs: ['run_id', 'suite_hash', 'report_json', 'tsr', 'pass_k', 'k', 'passed'], eval_results: ['run_id', 'case_id', 'attempt', 'passed', 'trace_json'] }).map(([name, cols]) => ({ id: name, name, columns: cols.map((name) => ({ name })) }));
  const root = path.resolve(import.meta.dirname, '..');
  const cases = loadSuites(path.join(root, 'eval', 'suites'), loadTools(path.join(root, 'workflows/chat-gateway.json')), ['security-v1']).cases;
  const store = new Map(tables.map((t) => [t.id, []])); let chats = 0;
  t.mock.method(globalThis, 'fetch', async (input, opts = {}) => {
    const url = new URL(input); const body = opts.body ? JSON.parse(opts.body) : null;
    const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/v1/data-tables') return response({ data: tables, nextCursor: null });
    if (url.pathname === '/api/v1/workflows') return response({ data: [{ name: 'Chat Stats API', active: true, nodes: [{ parameters: { jsCode: 'const bizRows = []' } }] }], nextCursor: null });
    if (url.pathname === '/webhook/v1/chat/completions') {
      chats++; assert.equal(opts.headers['x-client'], 'eval');
      const c = cases.find((c) => body.session_id.includes(c.id));
      assert.ok(c);
      store.get('chat_executions').push({ session_id: body.session_id, tool_trace: '[]', cost_usd: .001, total_tokens: 1 });
      return response({ choices: [{ message: { content: (c.expect.answer.must_include || ['合理摘要']).join(' ') } }] });
    }
    const m = url.pathname.match(/^\/api\/v1\/data-tables\/([^/]+)\/rows$/);
    assert.ok(m, `unexpected route ${url.pathname}`);
    if (m[1] === 'chat_executions' && chats >= traceFailureAfter) return new Response('{}', { status: 500 });
    if (opts.method === 'POST') { if (!loseWrite) store.get(m[1]).push(...body.data); return response({ data: body.data }); }
    const filter = JSON.parse(url.searchParams.get('filter'));
    return response({ data: store.get(m[1]).filter((r) => filter.filters.every((f) => r[f.columnName] === f.value)), nextCursor: null });
  });
  return { store, chats: () => chats };
}
for (const loseWrite of [false, true]) test(`synthetic transport: persistence read-back ${loseWrite ? 'must fail when rows lost' : 'verifies all attempt rows'}`, async (t) => {
  const dir = temp(t); const mock = fakeDeployment(t, { loseWrite });
  const code = await main(['--isolated-stack', '--deterministic-only', '--suites', 'security-v1', '--runs', '1', '--report', path.join(dir, 'report.json')], { N8N_URL: 'http://offline.invalid', N8N_API_KEY: 'offline-placeholder', CHAT_API_KEY: 'offline-placeholder' }, { privateDir: dir });
  assert.equal(code, loseWrite ? 1 : 0); assert.equal(mock.chats(), 10);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.release_ready, false);
  if (loseWrite) assert.equal(report.persisted.verified, false);
  else { assert.equal(report.persisted.verified_rows, 10); assert.equal(mock.store.get('eval_results').length, 10); }
});

test('stats exclude eval from business totals but retain raw client split', () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'workflows', 'chat-stats-api.json'), 'utf8'));
  const code = workflow.nodes.find((n) => n.name === 'Build Stats').parameters.jsCode;
  const rows = [
    { client: 'console', session_id: 'business', status: 'success', latency_ms: 10, cost_usd: .01 },
    { client: 'eval', session_id: 'eval-run', status: 'error', latency_ms: 999, cost_usd: 10 },
  ];
  const [result] = new Function('$input', code)({ all: () => rows.map((json) => ({ json })) });
  assert.equal(result.json.totals.total, 1); assert.equal(result.json.totals.error, 0);
  assert.equal(result.json.cost.total_cost_usd, .01); assert.equal(result.json.avg_latency_ms, 10);
  assert.deepEqual(result.json.by_client, { console: 1, eval: 1 });
  assert.equal(result.json.recent.length, 1);
});

test('replay rejects live failure due to unknown cost or a stop reason', () => {
  const c = sample(); const fx = fixture(c);
  fx.attempts[0].cost = null;
  assert.ok(replayFixture(fx, c, 'suite', 'harness', 3).some((e) => e.includes('cost')));
  fx.attempts[0] = { ...observation(), stop_reason: 'budget reached' };
  assert.ok(replayFixture(fx, c, 'suite', 'harness', 3).length);
});
test('TSR rounded to one does not mask even one failure', () => {
  const attempts = Array.from({ length: 20001 }, (_, i) => ({ passed: i !== 0, ms: 1, cost: 0 }));
  const results = [{ attempts }]; const report = { ...scorecard(results, 1, attempts.length), results };
  assert.equal(report.totals.tsr, 1); assert.equal(runFailed(report), true);
});
test('unknown token count remains unknown after subsequent known turns', async () => {
  const c = sample(); c.turns.push({ role: 'user', content: '继续' }); let calls = 0;
  const a = await runConversation(c, 1, { runId: 'unit', budget: 1, spent: () => 0, charge: () => {}, deterministicOnly: true,
    chat: async () => ({ ...observation(), trace: { ...observation().trace, cost: .001, tokens: ++calls === 1 ? null : 7 } }),
  });
  assert.equal(a.tokens, null); assert.equal(a.turns.length, 2);
});
test('raw report override cannot escape private output directory', (t) => {
  const dir = temp(t);
  assert.equal(privateOutput(path.join(dir, 'report.json'), dir), path.join(dir, 'report.json'));
  assert.throws(() => privateOutput(path.join(dir, '..', 'published.json'), dir), /must stay inside/);
});
test('trace HTTP failure preserves the charged attempt and prior successes', async (t) => {
  const dir = temp(t); const mock = fakeDeployment(t, { traceFailureAfter: 2 });
  const file = path.join(dir, 'report.json');
  const code = await main(['--isolated-stack', '--deterministic-only', '--suites', 'security-v1', '--runs', '3', '--report', file], { N8N_URL: 'http://offline.invalid', N8N_API_KEY: 'offline-placeholder', CHAT_API_KEY: 'offline-placeholder' }, { privateDir: dir });
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(code, 1); assert.equal(mock.chats(), 2); assert.equal(report.totals.attempts, 2);
  assert.equal(report.results[0].attempts[0].passed, true); assert.equal(report.results[0].attempts[1].passed, false);
  assert.equal(report.cost_usd, null); assert.equal(report.totals.tsr, null);
});
