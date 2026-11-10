import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MineError, parseArgs, createApi, findTables, scanRows, isEvalTraffic,
  parseTrace, looksReAsk, correlateExecution, mineCandidates, buildReport, writeReport, main,
} from './eval-mine.mjs';

// All HTTP is an injected in-memory transport. Only the exclusive-write tests
// create files, in OS temp directories removed after each test; no .env is read.
const NOW = new Date('2026-11-10T12:00:00.000Z');
const time = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const msg = (role, minutes, content = 'same question text', extra = {}) => ({
  session_id: 'business-session', role, content, createdAt: time(minutes), ...extra,
});
const exec = (minutes, extra = {}) => ({
  id: `execution-${minutes}`, session_id: 'business-session', status: 'error',
  createdAt: time(minutes), tool_trace: '[]', ...extra,
});
const page = (data, nextCursor = null) => ({ data, nextCursor });
const response = (body) => ({ ok: true, status: 200, json: async () => body });
const discovery = page([{ id: 'exec-table', name: 'chat_executions' }, { id: 'msg-table', name: 'chat_messages' }]);
const env = { N8N_URL: 'http://offline.invalid', N8N_API_KEY: 'offline-test-key' };
const apiFor = (fetchImpl, extra = {}) => createApi({ baseUrl: env.N8N_URL, key: env.N8N_API_KEY, fetchImpl, ...extra });
const hasCode = (code) => (error) => error instanceof MineError && error.code === code;
const script = fileURLToPath(new URL('./eval-mine.mjs', import.meta.url));

function transport(executions = [], messages = []) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers['X-N8N-API-KEY'], env.N8N_API_KEY);
    if (url.pathname === '/api/v1/data-tables') return response(discovery);
    assert.ok(['/api/v1/data-tables/exec-table/rows', '/api/v1/data-tables/msg-table/rows'].includes(url.pathname));
    assert.equal(url.searchParams.get('sortBy'), 'createdAt:desc');
    assert.match(input, /sortBy=createdAt%3Adesc/);
    const source = url.pathname.includes('exec-table') ? executions : messages;
    const offset = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor').match(/^opaque\+:(\d+)\/=$/)[1]) : 0;
    const end = offset + Number(url.searchParams.get('limit'));
    return response(page(source.slice(offset, end), end < source.length ? `opaque+:${end}/=` : null));
  };
  return { calls, fetchImpl };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-mine-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function runMain(fetchImpl, args = [], overrides = {}) {
  const stdout = [];
  const stderr = [];
  const writes = [];
  const code = await main(args, { env, now: () => NOW, fetchImpl,
    write: (report, outDir) => { writes.push({ report, outDir }); return path.join(outDir, 'candidates-offline.json'); },
    log: (line) => stdout.push(line), errorLog: (line) => stderr.push(line), ...overrides });
  return { code, stdout, stderr, writes };
}

test('defaults are local and positive integers are not clamped at 250', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.days, 14);
  assert.equal(defaults.limit, 200);
  assert.ok(defaults.outDir.endsWith(path.join('.eval-local', 'candidates')));
  const options = parseArgs(['--days', '3', '--limit', '2000', '--timeout-ms', '25', '--dry']);
  assert.deepEqual({ ...options, outDir: '' }, { days: 3, limit: 2000, timeoutMs: 25, dry: true, outDir: '' });
});

for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '0x10', '+3', ' 3', '3 ', '03', '9007199254740992']) {
  test(`rejects non-strict numeric argument ${JSON.stringify(value)}`, () => {
    for (const flag of ['--days', '--limit', '--timeout-ms']) {
      assert.throws(() => parseArgs([flag, value]), hasCode('invalid_numeric_argument'));
    }
  });
}

test('rejects missing, duplicate, unknown and overflowing arguments', () => {
  for (const args of [['--days'], ['--out', ''], ['--limit', '--dry'], ['--days', '3', '--days', '4'],
    ['--dry', '--dry'], ['--wat'], ['--days', '36501'], ['--timeout-ms', '2147483648']]) {
    assert.throws(() => parseArgs(args), MineError);
  }
});

test('module import has no CLI, credentials, network or write side effects', () => {
  const source = `delete process.env.N8N_API_KEY;
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    const fs = (await import('node:fs')).default;
    fs.mkdirSync = fs.writeFileSync = () => { throw new Error('write forbidden'); };
    await import(${JSON.stringify(new URL('./eval-mine.mjs', import.meta.url).href)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('table discovery follows encoded opaque cursors beyond the first 100 tables', async () => {
  const cursor = 'next+/= &?opaque';
  const urls = [];
  const api = apiFor(async (input) => {
    const url = new URL(input);
    urls.push(url);
    if (urls.length === 1) return response(page(Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `other${i}` })), cursor));
    assert.equal(url.searchParams.get('cursor'), cursor);
    assert.ok(input.includes(encodeURIComponent(cursor).replace(/%20/g, '+')));
    return response(discovery);
  });
  assert.equal((await findTables(api)).get('chat_messages'), 'msg-table');
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('limit'), '100');
});

test('both tables paginate beyond 250 and scan 620 executions / 620 messages', async () => {
  const executions = Array.from({ length: 620 }, (_, i) => exec(-i - 1, { session_id: `s${i}` }));
  const messages = Array.from({ length: 620 }, (_, i) => msg('user', -i - 1, `question ${i}`, { session_id: `s${i}` }));
  const mock = transport(executions, messages);
  const report = await buildReport(apiFor(mock.fetchImpl), parseArgs(['--days', '3', '--limit', '1000']), NOW);
  assert.equal(report.scanned_executions, 620);
  assert.equal(report.scanned_messages, 620);
  assert.equal(report.candidates, 620);
  assert.equal(report.coverage.executions.pages, 3);
  assert.equal(report.coverage.messages.pages, 3);
  assert.equal(mock.calls.length, 7);
  assert.equal(mock.calls[2].url.searchParams.get('cursor'), 'opaque+:250/=');
  assert.equal(report.truncated, false);
  assert.equal(report.window_scan_complete, true);
});

test('window cutoff is inclusive, excludes future rows and stops before another cursor', async () => {
  let calls = 0;
  const api = apiFor(async () => {
    calls++;
    return response(page([exec(1), exec(0), exec(-4320), exec(-4321)], 'older-page'));
  });
  const result = await scanRows(api, 'exec-table', { since: time(-4320), until: time(0), limit: 1000 });
  assert.equal(calls, 1);
  assert.deepEqual(result.rows.map((r) => r.createdAt), [time(0), time(-4320)]);
  assert.equal(result.coverage.stop_reason, 'window');
  assert.equal(result.coverage.truncated, false);
});

for (const limitedTable of ['executions', 'messages']) {
  test(`${limitedTable} budget alone marks the overall three-day report truncated`, async () => {
    const executions = Array.from({ length: limitedTable === 'executions' ? 401 : 1 }, (_, i) => exec(-i));
    const messages = Array.from({ length: limitedTable === 'messages' ? 401 : 1 }, (_, i) => msg('user', -i));
    const mock = transport(executions, messages);
    const report = await buildReport(apiFor(mock.fetchImpl), parseArgs(['--days', '3', '--limit', '300']), NOW);
    assert.equal(report.truncated, true);
    assert.equal(report.window_scan_complete, false);
    assert.equal(report.coverage[limitedTable].fetched_rows, 300);
    assert.equal(report.coverage[limitedTable].stop_reason, 'limit');
    const requests = mock.calls.filter(({ url }) => url.pathname.includes(limitedTable === 'executions' ? 'exec-table' : 'msg-table'));
    assert.deepEqual(requests.map(({ url }) => url.searchParams.get('limit')), ['250', '50']);
  });
}

test('exact budget with no remaining cursor is not truncated', async () => {
  const mock = transport([exec(-1), exec(-2)]);
  const result = await scanRows(apiFor(mock.fetchImpl), 'exec-table', { since: time(-4320), until: time(0), limit: 2 });
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.stop_reason, 'exhausted');
});

test('HTTP 401 fails without reading its body, writing a report or claiming zero candidates', async () => {
  let bodyRead = false;
  const result = await runMain(async () => ({ ok: false, status: 401, json: async () => { bodyRead = true; throw new Error('private body'); } }));
  assert.equal(result.code, 1);
  assert.equal(bodyRead, false);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.stdout, []);
  assert.deepEqual(result.stderr.map(JSON.parse), [{ error: 'http_error', http_status: 401 }]);
});

test('missing required table fails closed, including when only messages is missing', async () => {
  for (const tables of [[], [discovery.data[0]]]) {
    const result = await runMain(async () => response(page(tables)));
    assert.equal(result.code, 1);
    assert.equal(result.writes.length, 0);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(JSON.parse(result.stderr[0]), { error: 'required_table_missing' });
  }
});

test('invalid envelope or cursor shape never becomes an empty successful page', async () => {
  for (const body of [null, [], {}, { data: [] }, { data: {}, nextCursor: null },
    { data: [null], nextCursor: null }, { data: [], nextCursor: 123 }]) {
    await assert.rejects(apiFor(async () => response(body))('/data-tables', {}), hasCode('invalid_response_shape'));
  }
  await assert.rejects(apiFor(async () => response(page([], 'more')))('/data-tables', {}), hasCode('empty_cursor_page'));
  await assert.rejects(apiFor(async () => ({ ok: true, status: 200, json: async () => { throw new Error('private invalid JSON'); } }))('/data-tables', {}), hasCode('invalid_response_json'));
});

test('invalid row response on a later page aborts the whole run without output', async () => {
  const mock = transport(Array.from({ length: 300 }, (_, i) => exec(-i)));
  const result = await runMain((input, options) => new URL(input).searchParams.has('cursor')
    ? response({ data: 'private bad body', nextCursor: null }) : mock.fetchImpl(input, options), ['--limit', '500']);
  assert.equal(result.code, 1);
  assert.equal(result.writes.length, 0);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr[0]).error, 'invalid_response_shape');
});

test('fetch deadline aborts a hung request and a hung JSON body', async () => {
  for (const hangBody of [false, true]) {
    let signal;
    const api = apiFor(async (_, options) => {
      signal = options.signal;
      if (hangBody) return { ok: true, status: 200, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    }, { timeoutMs: 10 });
    await assert.rejects(api('/data-tables', {}), hasCode('request_timeout'));
    assert.equal(signal.aborted, true);
  }
});

test('network errors, missing credentials and unexpected exceptions are sanitized', async () => {
  const result = await runMain(async () => { throw new Error('private URL session and upstream text'); });
  assert.deepEqual(result.stderr.map(JSON.parse), [{ error: 'request_failed' }]);
  const missing = await runMain(() => assert.fail('must not fetch'), [], { env: {} });
  assert.deepEqual(missing.stderr.map(JSON.parse), [{ error: 'missing_api_key' }]);
  const failedWrite = await runMain(transport().fetchImpl, [], { write: () => { throw new Error('private output path'); } });
  assert.deepEqual(failedWrite.stderr.map(JSON.parse), [{ error: 'miner_failed' }]);
  assert.equal(failedWrite.stdout.length, 0);
});

test('repeated cursors fail instead of looping, for discovery and rows', async () => {
  const discoveryApi = apiFor(async () => response(page([{ id: 'other', name: 'other' }], 'repeat')));
  await assert.rejects(findTables(discoveryApi), hasCode('repeated_cursor'));
  const rowsApi = apiFor(async () => response(page([exec(-1)], 'repeat')));
  await assert.rejects(scanRows(rowsApi, 'exec-table', { since: time(-4320), until: time(0), limit: 1000 }), hasCode('repeated_cursor'));
});

test('invalid table metadata and duplicate required names fail', async () => {
  await assert.rejects(findTables(apiFor(async () => response(page([{ name: 'chat_executions' }])))), hasCode('invalid_table_shape'));
  await assert.rejects(findTables(apiFor(async () => response(page([discovery.data[0], discovery.data[0]])))), hasCode('ambiguous_table'));
});

test('invalid timestamps, ignored sorting and oversized pages fail closed', async () => {
  const options = { since: time(-4320), until: time(0), limit: 2 };
  for (const [data, code] of [
    [[exec(-1, { createdAt: 'invalid' })], 'invalid_row_timestamp'],
    [[exec(-2), exec(-1)], 'rows_not_descending'],
    [[exec(-1), exec(-2), exec(-3)], 'oversized_page'],
  ]) {
    await assert.rejects(scanRows(apiFor(async () => response(page(data))), 'exec-table', options), hasCode(code));
  }
  let calls = 0;
  const api = apiFor(async () => response(++calls === 1 ? page([exec(-2)], 'more') : page([exec(-1)])));
  await assert.rejects(scanRows(api, 'exec-table', options), hasCode('rows_not_descending'));
});

test('eval client and eval/phase*-eval sessions are excluded without matching normal words', () => {
  for (const session of ['eval', 'eval-run-1', 'eval/run', 'EVAL_smoke', 'phase1-eval-1', 'phase4.1-agent-eval-run']) {
    assert.equal(isEvalTraffic({ session_id: session }), true);
  }
  assert.equal(isEvalTraffic({ client: ' EVAL ' }), true);
  for (const session of ['evaluation-customer', 'reeval-chat', 'phase1-business', 'client-eval-request']) {
    assert.equal(isEvalTraffic({ session_id: session, client: 'console' }), false);
  }
});

test('eval exclusions apply to executions, messages and untagged companion rows', () => {
  const result = mineCandidates([
    exec(-1, { client: 'eval' }), exec(-2), exec(-1, { session_id: 'phase4.2-eval-run' }),
    exec(-1, { session_id: 'clean' }), exec(-1, { session_id: 'message-tagged' }),
  ], [msg('user', -2, 'eval secret'), msg('user', -2, 'business text', { session_id: 'clean' }),
    msg('user', -2, 'hidden', { session_id: 'message-tagged', client: 'eval' })]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].last_user_text, 'business text');
  assert.equal(result.excluded_eval_executions, 4);
  assert.equal(result.excluded_eval_messages, 2);
});

test('time fallback never assigns later user or assistant messages to an earlier execution', () => {
  const messages = [msg('user', -10, 'original question'), msg('assistant', -9, 'original answer'),
    msg('user', -5, 'future question'), msg('assistant', -4, 'future answer')];
  const earlier = mineCandidates([exec(-8)], messages).rows[0];
  assert.equal(earlier.last_user_text, 'original question');
  assert.deepEqual(earlier.assistant_texts, ['original answer']);
  assert.equal(earlier.correlation, 'time');
  assert.equal(earlier.signals.re_ask, false);
  assert.equal(mineCandidates([exec(-11)], messages).rows[0].last_user_text, '');
});

test('trace_id takes priority and assistants stay inside the selected user turn', () => {
  const messages = [msg('user', -10, 'trace question', { trace_id: 'target' }),
    msg('assistant', -9, 'trace answer', { trace_id: 'target' }),
    msg('user', -8, 'unrelated question', { trace_id: 'other' }),
    msg('assistant', -7, 'unrelated answer', { trace_id: 'other' })];
  const turn = correlateExecution(exec(-6, { trace_id: 'target' }), messages);
  assert.equal(turn.match, 'trace_id');
  assert.equal(turn.user.content, 'trace question');
  assert.deepEqual(turn.assistants.map((m) => m.content), ['trace answer']);
});

test('future matching traces, conflicting traces and missing sessions do not invent a match', () => {
  const messages = [msg('user', -5, 'future', { trace_id: 'target' })];
  assert.equal(correlateExecution(exec(-6, { trace_id: 'target' }), messages).match, 'none');
  assert.equal(correlateExecution(exec(-4, { trace_id: 'other' }), messages).match, 'none');
  for (const session_id of ['', 'unknown']) {
    assert.equal(correlateExecution(exec(-4, { session_id }), [msg('user', -5, 'anonymous', { session_id })]).match, 'none');
  }
  const fallback = correlateExecution(exec(-4, { trace_id: 'new' }), [msg('user', -5)]);
  assert.equal(fallback.match, 'time');
});

test('re-ask belongs only to the later turn with an assistant between users', () => {
  const messages = [msg('user', -10), msg('assistant', -9), msg('user', -8, 'Same   question text again'), msg('assistant', -7)];
  const first = mineCandidates([exec(-9)], messages).rows[0];
  const second = mineCandidates([exec(-6, { status: 'success' })], messages).rows[0];
  assert.equal(first.signals.re_ask, false);
  assert.equal(second.signals.re_ask, true);
  assert.deepEqual(second.triage, { decision: '', why: '', mapped_tools: '', expected_assertions: '' });
});

test('re-ask rejects no answer, answer outside interval, ambiguous ties and stale/different questions', () => {
  const invalid = [
    [msg('user', -5), msg('user', -4)],
    [msg('assistant', -6), msg('user', -5), msg('user', -4)],
    [msg('user', -5), msg('user', -4), msg('assistant', -3)],
    [msg('user', -5), msg('assistant', -5), msg('user', -4)],
    [msg('user', -5), msg('assistant', -4), msg('user', -4)],
    [msg('user', -10), msg('assistant', -9), msg('user', -1)],
    [msg('user', -5), msg('assistant', -4), msg('user', -3, 'entirely different')],
    [msg('user', -5, 'short'), msg('assistant', -4), msg('user', -3, 'short')],
  ];
  for (const messages of invalid) {
    const idx = messages.findLastIndex((m) => m.role === 'user');
    assert.equal(looksReAsk(messages, idx), false);
  }
  assert.equal(looksReAsk([msg('user', -6), msg('assistant', -5), msg('user', -1)], 2), true);
});

test('unrelated sessions cannot provide an assistant for a re-ask', () => {
  const result = mineCandidates([exec(-1, { status: 'success' })], [msg('user', -5),
    msg('assistant', -4, 'other session', { session_id: 'other' }), msg('user', -3)]);
  assert.equal(result.rows.length, 0);
});

test('tool JSON signals remain candidates, cap alone is context, malformed traces are counted', () => {
  const tool_trace = JSON.stringify([{ tool: 'kb_save', ok: false, blocked: true, args: { text: 'private args' } }]);
  assert.deepEqual(parseTrace(tool_trace)[0].ok, false);
  for (const raw of ['{', '{}', '[null]', '[{"tool":"kb_save"}]']) assert.equal(parseTrace(raw), null);
  const result = mineCandidates([exec(-1, { status: 'success', tool_trace }),
    exec(-2, { status: 'success', tool_rounds: 2 }), exec(-3, { status: 'success', tool_trace: '{' })], []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].signals.tool_error, true);
  assert.equal(result.rows[0].signals.tool_blocked, true);
  assert.equal(result.rows[1].score, 1);
  assert.equal(result.rows[1].signals.status_error, false);
  assert.equal(result.rows[1].triage.why, '');
  assert.equal(result.warnings.invalid_tool_traces, 1);
  assert.equal(result.warnings.unmatched_executions, 3);
  assert.ok(!JSON.stringify(result).includes('private args'));
});

test('same-day runs preserve existing daily triage and generate distinct timestamp/random files', (t) => {
  const dir = tempDir(t);
  const oldPath = path.join(dir, 'candidates-2026-11-10.json');
  const triaged = JSON.stringify({ triage: { why: 'human decision must survive' } });
  fs.writeFileSync(oldPath, triaged);
  const report = { generated_at: NOW.toISOString(), rows: [] };
  const first = writeReport(report, dir);
  const second = writeReport(report, dir);
  assert.notEqual(first, second);
  assert.match(path.basename(first), /^candidates-2026-11-10T12-00-00-000Z-[a-f0-9-]+\.json$/);
  assert.equal(fs.readFileSync(oldPath, 'utf8'), triaged);
  assert.deepEqual(JSON.parse(fs.readFileSync(first, 'utf8')), report);
  assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')), report);
  assert.equal(fs.readdirSync(dir).length, 3);
});

test('exclusive creation retries nonce collision and never overwrites manual triage', (t) => {
  const dir = tempDir(t);
  const report = { generated_at: NOW.toISOString(), rows: [] };
  const first = writeReport(report, dir, { nonce: () => 'collision' });
  const triaged = '{"triage":{"why":"keep this edited report"}}';
  fs.writeFileSync(first, triaged);
  let attempts = 0;
  const second = writeReport(report, dir, { nonce: () => ++attempts === 1 ? 'collision' : 'different' });
  assert.notEqual(first, second);
  assert.equal(attempts, 2);
  assert.throws(() => writeReport(report, dir, { nonce: () => 'collision' }), hasCode('report_name_collision'));
  assert.equal(fs.readFileSync(first, 'utf8'), triaged);
});

test('stdout contains aggregate counts but no original text, errors, session or candidate identifiers', async () => {
  const secret = { session_id: 'private-session-marker', trace_id: 'private-trace-marker', execution_id: 'private-execution-marker' };
  const mock = transport([exec(-1, { ...secret, error_message: 'private-error-marker', tool_trace: JSON.stringify([{ tool: 'private-tool-marker', ok: false }]) })],
    [msg('assistant', -2, 'private-answer-marker', secret), msg('user', -3, 'private-question-marker', secret)]);
  const result = await runMain(mock.fetchImpl, ['--days', '3']);
  assert.equal(result.code, 0);
  assert.equal(result.writes[0].report.rows[0].last_user_text, 'private-question-marker');
  assert.equal(result.writes[0].report.rows[0].error_message, 'private-error-marker');
  assert.equal(result.stdout.length, 1);
  assert.ok(!result.stdout.join('').includes('private-'));
  assert.equal(JSON.parse(result.stdout[0]).candidates, 1);
  assert.equal(result.stderr.length, 0);
});

test('successful empty scan is distinguishable from errors and still not a health verdict', async () => {
  const result = await runMain(transport().fetchImpl);
  assert.equal(result.code, 0);
  assert.equal(result.writes.length, 1);
  assert.equal(JSON.parse(result.stdout[0]).candidates, 0);
  assert.match(JSON.parse(result.stdout[0]).note, /not a health verdict/);
});

test('--dry does not inspect credentials, call fetch, consult clock or write', async () => {
  const forbidden = () => assert.fail('dry side effect');
  const result = await runMain(forbidden, ['--dry', '--days', '3', '--limit', '1000'], {
    env: new Proxy({}, { get: forbidden }), now: forbidden, write: forbidden,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(JSON.parse(result.stdout[0]).dry, true);
});

test('actual CLI dry-run exits cleanly without creating the requested directory', (t) => {
  const dir = path.join(tempDir(t), 'must-not-exist');
  const child = spawnSync(process.execPath, [script, '--dry', '--days', '3', '--out', dir], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).dry, true);
  assert.equal(child.stderr, '');
  assert.equal(fs.existsSync(dir), false);
});

test('CLI invalid arguments fail without printing the supplied value', () => {
  const child = spawnSync(process.execPath, [script, '--days', 'private-invalid-value'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), { error: 'invalid_numeric_argument' });
});
