// Offline contract tests for the sandbox gateway admission layer (P1).
// No Kubernetes, no network beyond loopback: the real HTTP handler runs
// against a fake runJob, and the token bucket runs on a fake clock.
//
// Run: node --test n8n/sandbox-gateway.test.mjs
//
// Negative controls are deliberate: several tests assert that a REFUSAL
// happens (and that the same request is admitted under a relaxed config),
// so a gate that silently lets everything through fails here.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { patchPlatformSandboxCaller } from './scripts/sandbox-caller-patch.mjs';

const require = createRequire(import.meta.url);
const { createGatewayServer } = require('./sandbox_gateway.js');
const { parseCaller, clampInt, parseAllowedCallers, admissionConfigFromEnv, createAdmission } = require('./sandbox_admission.js');
const { createMetrics } = require('./sandbox_metrics.js');

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// admission unit contracts
// ---------------------------------------------------------------------------

test('parseCaller: absent header falls back to default', () => {
  assert.deepEqual(parseCaller(undefined), { caller: 'default' });
  assert.deepEqual(parseCaller(''), { caller: 'default' });
});

test('parseCaller: valid identities pass unchanged', () => {
  assert.deepEqual(parseCaller('chat-gateway'), { caller: 'chat-gateway' });
  assert.deepEqual(parseCaller('agent-eval'), { caller: 'agent-eval' });
  assert.deepEqual(parseCaller('a'), { caller: 'a' });
  assert.deepEqual(parseCaller('x'.repeat(32)), { caller: 'x'.repeat(32) });
});

test('parseCaller: invalid identities are refused, never normalised', () => {
  for (const bad of ['Chat-Gateway', 'has space', 'x'.repeat(33), '-leading', 'under_score!', 'a/b', 'é']) {
    assert.deepEqual(parseCaller(bad), { error: 'invalid_caller' }, `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test('clampInt: env garbage falls back, ranges are enforced', () => {
  assert.equal(clampInt(undefined, 30, 1, 6000), 30);
  assert.equal(clampInt('abc', 30, 1, 6000), 30);
  assert.equal(clampInt('0', 30, 1, 6000), 1);
  assert.equal(clampInt('-5', 30, 1, 6000), 1);
  assert.equal(clampInt('99999', 30, 1, 6000), 6000);
  assert.equal(clampInt('12.9', 30, 1, 6000), 12);
});

test('parseAllowedCallers: empty means accounting mode, malformed fails closed', () => {
  assert.deepEqual(parseAllowedCallers(''), []);
  assert.deepEqual(parseAllowedCallers(undefined), []);
  assert.deepEqual(parseAllowedCallers(' chat-gateway , agent-eval ,chat-gateway '), ['chat-gateway', 'agent-eval']);
  assert.throws(() => parseAllowedCallers('chat-gateway,Bad Caller'), /not a valid caller identity/);
});

test('admissionConfigFromEnv: defaults and overrides', () => {
  assert.deepEqual(admissionConfigFromEnv({}), { rateRpm: 30, rateBurst: 10, maxInflight: 4, allowedCallers: [] });
  const custom = admissionConfigFromEnv({ SANDBOX_RATE_RPM: '60', SANDBOX_RATE_BURST: '5', SANDBOX_MAX_INFLIGHT: '2', SANDBOX_ALLOWED_CALLERS: 'chat-gateway' });
  assert.deepEqual(custom, { rateRpm: 60, rateBurst: 5, maxInflight: 2, allowedCallers: ['chat-gateway'] });
});

test('token bucket: burst then refuse, refill over time, callers isolated', () => {
  let clock = 1_000_000;
  const admission = createAdmission({ rateRpm: 60, rateBurst: 3, now: () => clock });
  for (let i = 0; i < 3; i += 1) assert.equal(admission.check('a').allowed, true);
  const refused = admission.check('a');
  assert.equal(refused.allowed, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.error, 'rate_limited');
  assert.ok(refused.retryAfterSec >= 1);
  // Another caller has its own bucket.
  assert.equal(admission.check('b').allowed, true);
  // 1 second at 60 rpm refills exactly one token.
  clock += 1000;
  assert.equal(admission.check('a').allowed, true);
  assert.equal(admission.check('a').allowed, false);
  // Refill never exceeds the burst capacity.
  clock += 600_000;
  for (let i = 0; i < 3; i += 1) assert.equal(admission.check('a').allowed, true);
  assert.equal(admission.check('a').allowed, false);
});

test('allowlist: unlisted callers get 403 even with tokens left', () => {
  const admission = createAdmission({ allowedCallers: ['chat-gateway'] });
  assert.equal(admission.check('chat-gateway').allowed, true);
  const refused = admission.check('intruder');
  assert.equal(refused.allowed, false);
  assert.equal(refused.status, 403);
  assert.equal(refused.error, 'caller_not_allowed');
  // Header-less callers map to "default" and are also blocked by the list.
  assert.equal(admission.check('default').allowed, false);
});

test('concurrency cap: acquire up to the cap, release frees a slot', () => {
  const admission = createAdmission({ maxInflight: 2 });
  assert.equal(admission.acquire(), true);
  assert.equal(admission.acquire(), true);
  assert.equal(admission.acquire(), false);
  assert.equal(admission.inflight, 2);
  admission.release();
  assert.equal(admission.acquire(), true);
  admission.release();
  admission.release();
  assert.equal(admission.inflight, 0);
  admission.release(); // never negative
  assert.equal(admission.inflight, 0);
});

// ---------------------------------------------------------------------------
// metrics rendering contracts
// ---------------------------------------------------------------------------

test('metrics: counters, histogram and gauge render as Prometheus text', () => {
  const metrics = createMetrics();
  metrics.request('chat-gateway', 'admitted');
  metrics.request('chat-gateway', 'admitted');
  metrics.request('unknown', 'unauthorized');
  metrics.run('chat-gateway', 'ok');
  metrics.observeJobSeconds(1.2);
  metrics.setInflight(1);
  const text = metrics.render();
  assert.match(text, /sandbox_gateway_requests_total\{caller="chat-gateway",decision="admitted"\} 2/);
  assert.match(text, /sandbox_gateway_requests_total\{caller="unknown",decision="unauthorized"\} 1/);
  assert.match(text, /sandbox_gateway_runs_total\{caller="chat-gateway",outcome="ok"\} 1/);
  assert.match(text, /sandbox_gateway_inflight_jobs 1/);
  assert.match(text, /sandbox_gateway_job_duration_seconds_bucket\{le="2"\} 1/);
  assert.match(text, /sandbox_gateway_job_duration_seconds_bucket\{le="0\.5"\} 0/);
  assert.match(text, /sandbox_gateway_job_duration_seconds_count 1/);
  assert.match(text, /# TYPE sandbox_gateway_requests_total counter/);
  assert.match(text, /# TYPE sandbox_gateway_job_duration_seconds histogram/);
});

// ---------------------------------------------------------------------------
// HTTP contract: real handler, fake runJob
// ---------------------------------------------------------------------------

// A timed-out test never reaches its finally block, so servers are also
// tracked here and force-closed by the root after() hook. Without this, one
// broken gate (e.g. a mutation that removes the concurrency cap) hangs the
// whole runner instead of failing it.
const openServers = new Set();
after(() => {
  for (const server of openServers) {
    server.closeAllConnections();
    server.close();
  }
  openServers.clear();
});

const startGateway = async ({ admissionOptions = {}, runJob, allowedCallers } = {}) => {
  const admission = createAdmission({ ...admissionOptions, ...(allowedCallers ? { allowedCallers } : {}) });
  const metrics = createMetrics();
  const logs = [];
  const server = createGatewayServer({
    sandboxKey: 'test-key',
    runJob: runJob || (async () => ({ status: 200, body: { ok: true, stdout: '4\n', exit_code: 0 } })),
    admission,
    metrics,
    log: (fields) => logs.push(fields),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'POST', headers = {}, body } = {}) => fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const run = (body, headers = {}) => call('/run', { headers: { 'x-sandbox-key': 'test-key', ...headers }, body });
  return {
    base, call, run, admission, metrics, logs,
    metricsText: async () => (await call('/metrics', { method: 'GET' })).text(),
    // undici keeps sockets alive; without closeAllConnections server.close()
    // waits forever on idle keep-alive connections. Idempotent: the root
    // after() hook may close the same server again.
    close: () => new Promise((resolve) => {
      openServers.delete(server);
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

test('http: healthz and metrics need no key; unknown routes 404', { timeout: 10000 }, async () => {
  const gw = await startGateway();
  try {
    const health = await gw.call('/healthz', { method: 'GET' });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'platform-sandbox-gateway' });
    const metrics = await gw.call('/metrics', { method: 'GET' });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /sandbox_gateway_up 1/);
    assert.equal((await gw.call('/nope', { method: 'GET' })).status, 404);
    assert.equal((await gw.call('/run', { method: 'GET' })).status, 404);
  } finally { await gw.close(); }
});

test('http: missing or wrong key is 401 and counted as unauthorized', { timeout: 10000 }, async () => {
  const gw = await startGateway();
  try {
    const missing = await gw.call('/run', { body: { code: 'print(1)' } });
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { ok: false, error: 'unauthorized' });
    const wrong = await gw.run({ code: 'print(1)' }, { 'x-sandbox-key': 'wrong' });
    assert.equal(wrong.status, 401);
    const text = await gw.metricsText();
    assert.match(text, /sandbox_gateway_requests_total\{caller="unknown",decision="unauthorized"\} 2/);
    assert.ok(gw.logs.some((l) => l.event === 'request_rejected' && l.decision === 'unauthorized'));
  } finally { await gw.close(); }
});

test('http: valid request runs the job; default and explicit caller are labelled', { timeout: 10000 }, async () => {
  const seen = [];
  const gw = await startGateway({ runJob: async (body) => { seen.push(body); return { status: 200, body: { ok: true, stdout: '4\n' } }; } });
  try {
    const anon = await gw.run({ code: 'print(2+2)', timeout: 5, allow_network: false });
    assert.equal(anon.status, 200);
    assert.deepEqual(await anon.json(), { ok: true, stdout: '4\n' });
    const named = await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'chat-gateway' });
    assert.equal(named.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].code, 'print(2+2)');
    const text = await gw.metricsText();
    assert.match(text, /sandbox_gateway_requests_total\{caller="default",decision="admitted"\} 1/);
    assert.match(text, /sandbox_gateway_requests_total\{caller="chat-gateway",decision="admitted"\} 1/);
    assert.match(text, /sandbox_gateway_runs_total\{caller="chat-gateway",outcome="ok"\} 1/);
    assert.match(text, /sandbox_gateway_job_duration_seconds_count 2/);
    assert.match(text, /sandbox_gateway_inflight_jobs 0/);
  } finally { await gw.close(); }
});

test('http: invalid caller identity is 400 before any job runs', { timeout: 10000 }, async () => {
  let runs = 0;
  const gw = await startGateway({ runJob: async () => { runs += 1; return { status: 200, body: { ok: true } }; } });
  try {
    const res = await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'Bad Caller' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'invalid_caller' });
    assert.equal(runs, 0);
    assert.match(await gw.metricsText(), /decision="invalid_caller"\} 1/);
  } finally { await gw.close(); }
});

test('http: allowlist enforcement blocks unlisted callers with 403 (negative control)', { timeout: 10000 }, async () => {
  const gw = await startGateway({ allowedCallers: ['chat-gateway'] });
  try {
    assert.equal((await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'chat-gateway' })).status, 200);
    const blocked = await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'agent-eval' });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { ok: false, error: 'caller_not_allowed' });
    // Header-less "default" is not on the list either.
    assert.equal((await gw.run({ code: 'print(1)' })).status, 403);
    const text = await gw.metricsText();
    assert.match(text, /sandbox_gateway_requests_total\{caller="agent-eval",decision="caller_not_allowed"\} 1/);
    assert.match(text, /sandbox_gateway_requests_total\{caller="default",decision="caller_not_allowed"\} 1/);
  } finally { await gw.close(); }
  // Same requests under accounting mode (no allowlist) must be admitted:
  // proves the 403s above came from the allowlist, not a broken handler.
  const open = await startGateway();
  try {
    assert.equal((await open.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'agent-eval' })).status, 200);
    assert.equal((await open.run({ code: 'print(1)' })).status, 200);
  } finally { await open.close(); }
});

test('http: per-caller rate limit returns 429 + Retry-After; other callers unaffected', { timeout: 10000 }, async () => {
  const gw = await startGateway({ admissionOptions: { rateRpm: 60, rateBurst: 2 } });
  try {
    assert.equal((await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'noisy' })).status, 200);
    assert.equal((await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'noisy' })).status, 200);
    const refused = await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'noisy' });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(body.retry_after >= 1);
    assert.equal(refused.headers.get('retry-after'), String(body.retry_after));
    // A different caller still has its own budget.
    assert.equal((await gw.run({ code: 'print(1)' }, { 'x-sandbox-caller': 'quiet' })).status, 200);
    const text = await gw.metricsText();
    assert.match(text, /sandbox_gateway_requests_total\{caller="noisy",decision="rate_limited"\} 1/);
    assert.match(text, /sandbox_gateway_requests_total\{caller="quiet",decision="admitted"\} 1/);
  } finally { await gw.close(); }
});

test('http: malformed requests spend rate tokens (flood still costs quota)', { timeout: 10000 }, async () => {
  const gw = await startGateway({ admissionOptions: { rateRpm: 60, rateBurst: 1 } });
  try {
    const bad = await gw.call('/run', { headers: { 'x-sandbox-key': 'test-key' }, body: undefined });
    // No body at all -> '{}' parses, code missing -> 400, but the token is spent.
    assert.equal(bad.status, 400);
    const refused = await gw.run({ code: 'print(1)' });
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'rate_limited');
  } finally { await gw.close(); }
});

test('http: concurrency cap returns 429 busy while slots are held, then recovers', { timeout: 10000 }, async () => {
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  let hold = true;
  // unref: if a mutation makes this test time out, the polling timer must not
  // keep the process alive after the runner is done.
  const gate = new Promise((resolve) => { firstStarted.then(() => { const check = () => { if (!hold) return resolve(); const timer = setTimeout(check, 5); timer.unref(); }; check(); }); });
  const gw = await startGateway({
    admissionOptions: { maxInflight: 1, rateBurst: 10 },
    runJob: async () => { releaseFirst(); await gate; return { status: 200, body: { ok: true } }; },
  });
  try {
    const first = gw.run({ code: 'import time; time.sleep(1)' });
    await firstStarted;
    const refused = await gw.run({ code: 'print(1)' });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.error, 'busy');
    assert.equal(refused.headers.get('retry-after'), '1');
    assert.match(await gw.metricsText(), /sandbox_gateway_inflight_jobs 1/);
    hold = false;
    assert.equal((await first).status, 200);
    // Slot released: the next request is admitted.
    assert.equal((await gw.run({ code: 'print(1)' })).status, 200);
    const text = await gw.metricsText();
    assert.match(text, /decision="busy"\} 1/);
    assert.match(text, /sandbox_gateway_inflight_jobs 0/);
  } finally { hold = false; await gw.close(); }
});

test('http: existing input guards keep their exact bodies and statuses', { timeout: 10000 }, async () => {
  const gw = await startGateway();
  try {
    const tooLarge = await gw.call('/run', { headers: { 'x-sandbox-key': 'test-key' }, body: { code: 'x'.repeat(25000) } });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { ok: false, error: 'request too large' });
    const empty = await gw.run({ code: '   ' });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { ok: false, error: 'code is required' });
    const long = await gw.run({ code: 'x'.repeat(20001) });
    assert.equal(long.status, 400);
    assert.deepEqual(await long.json(), { ok: false, error: 'code too long' });
    const text = await gw.metricsText();
    assert.match(text, /decision="too_large"\} 1/);
    assert.match(text, /decision="invalid_request"\} 2/);
  } finally { await gw.close(); }
});

test('http: invalid JSON body is 400 invalid json', { timeout: 10000 }, async () => {
  const gw = await startGateway();
  try {
    const res = await fetch(gw.base + '/run', { method: 'POST', headers: { 'x-sandbox-key': 'test-key', 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'invalid json' });
  } finally { await gw.close(); }
});

test('http: job failure, timeout and thrown errors map to 502/504 and outcome counters', { timeout: 10000 }, async () => {
  let mode = 'failed';
  const gw = await startGateway({
    admissionOptions: { rateBurst: 20 },
    runJob: async () => {
      if (mode === 'failed') return { status: 502, body: { ok: false, error: 'sandbox_job_failed' } };
      if (mode === 'timeout') return { status: 504, body: { ok: false, timeout: true, message: '执行超时（Kubernetes Job）' } };
      throw new Error('k8s api exploded');
    },
  });
  try {
    const failed = await gw.run({ code: 'print(1)' });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { ok: false, error: 'sandbox_job_failed' });
    mode = 'timeout';
    const timeout = await gw.run({ code: 'print(1)' });
    assert.equal(timeout.status, 504);
    assert.equal((await timeout.json()).timeout, true);
    mode = 'throw';
    const thrown = await gw.run({ code: 'print(1)' });
    assert.equal(thrown.status, 502);
    assert.match((await thrown.json()).error, /k8s api exploded/);
    const text = await gw.metricsText();
    assert.match(text, /outcome="job_failed"\} 1/);
    assert.match(text, /outcome="timeout"\} 1/);
    assert.match(text, /outcome="error"\} 1/);
    // Slots are released even when runJob throws.
    assert.match(text, /sandbox_gateway_inflight_jobs 0/);
    assert.equal(gw.admission.inflight, 0);
  } finally { await gw.close(); }
});

// ---------------------------------------------------------------------------
// deploy-time caller patch contracts
// ---------------------------------------------------------------------------

const loadChatGateway = () => JSON.parse(readFileSync(join(here, 'workflows', 'chat-gateway.json'), 'utf8'));
const executeCode = (wf) => wf.nodes.find((n) => n.name === 'Execute Tool').parameters.jsCode;

test('patch: committed chat-gateway gains SANDBOX_URL routing and the caller header', () => {
  const wf = loadChatGateway();
  patchPlatformSandboxCaller(wf);
  const code = executeCode(wf);
  assert.ok(code.includes('$env.SANDBOX_APPROVED_URL || $env.SANDBOX_URL'), 'approved-network routing present');
  assert.ok(code.includes("$env.SANDBOX_URL || 'http://n8n-sandbox:8000'"), 'ordinary routing present');
  assert.ok(code.includes("'x-sandbox-caller': 'chat-gateway'"), 'caller identity present');
  assert.ok(!code.includes("url: 'http://n8n-sandbox:8000/run',"), 'hardcoded URL replaced');
});

test('patch: idempotent and safe on already-patched instances', () => {
  const wf = loadChatGateway();
  patchPlatformSandboxCaller(wf);
  const once = executeCode(wf);
  patchPlatformSandboxCaller(wf);
  assert.equal(executeCode(wf), once, 'second apply must be a no-op');
  // Simulate a live instance that already had the URL patch but predates the
  // header: the header must still be added (upgrade path).
  const legacy = loadChatGateway();
  const code = executeCode(legacy);
  const marker = "url: 'http://n8n-sandbox:8000/run',";
  const urlReplacement = "url: ((allowNetwork ? ($env.SANDBOX_APPROVED_URL || $env.SANDBOX_URL) : ($env.SANDBOX_URL || 'http://n8n-sandbox:8000')).replace(/\\/$/, '')) + '/run',";
  legacy.nodes.find((n) => n.name === 'Execute Tool').parameters.jsCode = code.replace(marker, urlReplacement);
  patchPlatformSandboxCaller(legacy);
  assert.ok(executeCode(legacy).includes("'x-sandbox-caller': 'chat-gateway'"));
});

test('patch: workflow without Execute Tool is returned untouched', () => {
  const wf = { nodes: [{ name: 'Other', parameters: {} }] };
  assert.equal(patchPlatformSandboxCaller(wf), wf);
});