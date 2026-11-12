#!/usr/bin/env node
/* Offline contracts for the agent-platform OpenTelemetry tracer.
 *
 * No network, no dependencies, no collector — safe to run in CI. A fake fetchFn
 * captures the OTLP/JSON payload so the export shape and the fail-open contract
 * are exercised without any I/O. Run: node --test monitoring/otel/tracer.test.mjs
 *
 * Coverage:
 *   - W3C traceparent parse/format round-trip + invalid/all-zero rejection
 *   - OTLP/JSON span shape (hex ids, int64-as-string, kind enum, status, root
 *     omits parentSpanId) and ResourceSpans envelope
 *   - cross-service propagation continuity (extract -> child -> inject -> extract)
 *   - opt-in: disabled tracer is a no-op and inject() leaves headers untouched
 *   - fail-open NEGATIVE CONTROLS: a throwing / rejecting collector never throws
 *     into the host and never wedges the buffer
 *   - drift guard: the canonical tracer and both vendored copies are byte-identical
 *     and each copy is functional in its own module context (CJS .js / .cjs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(import.meta.url);
const canonical = require(join(here, 'tracer.js'));
const { createTracer, parseTraceparent, formatTraceparent, toAttributes, SPAN_KIND, STATUS } = canonical;

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* A fake fetch that records every call and returns a configurable response. */
function recordingFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (typeof response === 'function') return response(url, opts);
    return response || { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------------ traceparent */
test('parseTraceparent accepts a valid header and round-trips', () => {
  const p = parseTraceparent(TP);
  assert.deepEqual(p, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: '01' });
  assert.equal(formatTraceparent(p.traceId, p.spanId, p.flags), TP);
});

test('parseTraceparent normalizes case and trims whitespace', () => {
  const p = parseTraceparent('  00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01  ');
  assert.equal(p.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(p.spanId, '00f067aa0ba902b7');
});

test('parseTraceparent rejects malformed and all-zero ids', () => {
  const bad = [
    null, undefined, '', 'garbage',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // missing flags
    '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01', // short trace
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01', // short span
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01', // all-zero trace
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', // all-zero span
    '00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01', // non-hex
  ];
  for (const v of bad) assert.equal(parseTraceparent(v), null, `should reject: ${v}`);
});

/* ------------------------------------------------------------------ attributes */
test('toAttributes maps OTLP AnyValue types and drops nullish', () => {
  const attrs = toAttributes({ i: 5, d: 1.5, b: true, s: 'x', n: null, u: undefined });
  const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
  assert.deepEqual(byKey.i, { intValue: '5' }); // int64 as JSON string
  assert.deepEqual(byKey.d, { doubleValue: 1.5 });
  assert.deepEqual(byKey.b, { boolValue: true });
  assert.deepEqual(byKey.s, { stringValue: 'x' });
  assert.equal(byKey.n, undefined);
  assert.equal(byKey.u, undefined);
  assert.equal(attrs.length, 4);
});

/* ------------------------------------------------------------------ opt-in / disabled */
test('disabled tracer (no endpoint) is a no-op and preserves headers', () => {
  const t = createTracer({ serviceName: 'off' });
  assert.equal(t.enabled, false);
  const headers = { 'x-trace-id': 'abc', traceparent: TP };
  const span = t.startSpan('noop', { kind: SPAN_KIND.SERVER });
  // inject must leave headers byte-for-byte unchanged when disabled
  assert.deepEqual(t.inject(headers, span), headers);
  assert.equal(t.inject(headers, span).traceparent, TP);
  // inject on header-less input adds no traceparent when disabled
  assert.deepEqual(t.inject({ a: '1' }, span), { a: '1' });
  t.endSpan(span, { status: STATUS.OK });
  assert.equal(t._buffer.length, 0); // nothing queued
});

test('enabled:false overrides a configured endpoint (opt-in)', () => {
  const t = createTracer({ endpoint: 'http://collector:4318', enabled: false });
  assert.equal(t.enabled, false);
});

test('endpoint presence enables; trailing slash is normalized', async () => {
  const fetchFn = recordingFetch();
  const t = createTracer({ serviceName: 'svc', endpoint: 'http://collector:4318/', fetchFn, flushIntervalMs: 60000 });
  assert.equal(t.enabled, true);
  const s = t.startSpan('probe');
  t.endSpan(s, { status: STATUS.OK });
  await t.flush();
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, 'http://collector:4318/v1/traces'); // single slash
  await t.shutdown();
});

/* ------------------------------------------------------------------ span shape */
test('root span has OTLP/JSON shape: hex ids, string int64, kind enum, no parentSpanId', async () => {
  const fetchFn = recordingFetch();
  const t = createTracer({ serviceName: 'shape-svc', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000 });
  const s = t.startSpan('root-op', { kind: SPAN_KIND.SERVER, attributes: { 'http.method': 'POST', 'http.status_code': 200 } });
  t.endSpan(s, { status: STATUS.OK, attributes: { 'extra': 'v' } });
  await t.flush();
  const payload = fetchFn.calls[0].body;
  // ResourceSpans envelope
  assert.ok(Array.isArray(payload.resourceSpans));
  const rs = payload.resourceSpans[0];
  const svcAttr = rs.resource.attributes.find((a) => a.key === 'service.name');
  assert.deepEqual(svcAttr.value, { stringValue: 'shape-svc' });
  assert.ok(Array.isArray(rs.scopeSpans));
  const spans = rs.scopeSpans[0].spans;
  assert.equal(spans.length, 1);
  const sp = spans[0];
  assert.match(sp.traceId, /^[0-9a-f]{32}$/); // HEX, not base64 (OTLP/JSON special case)
  assert.match(sp.spanId, /^[0-9a-f]{16}$/);
  assert.equal(sp.parentSpanId, undefined); // root omits parentSpanId
  assert.equal(sp.name, 'root-op');
  assert.equal(sp.kind, SPAN_KIND.SERVER); // integer enum (2)
  assert.equal(typeof sp.startTimeUnixNano, 'string'); // int64 as string
  assert.equal(typeof sp.endTimeUnixNano, 'string');
  assert.match(sp.startTimeUnixNano, /^\d+$/);
  assert.ok(BigInt(sp.endTimeUnixNano) >= BigInt(sp.startTimeUnixNano));
  assert.deepEqual(sp.status, { code: STATUS.OK });
  const keys = sp.attributes.map((a) => a.key);
  assert.ok(keys.includes('http.method') && keys.includes('http.status_code') && keys.includes('extra'));
  await t.shutdown();
});

test('error span sets ERROR status with a truncated message', async () => {
  const fetchFn = recordingFetch();
  const t = createTracer({ serviceName: 'err-svc', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000 });
  const s = t.startSpan('boom');
  t.endSpan(s, { error: new Error('x'.repeat(500)) });
  await t.flush();
  const sp = fetchFn.calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(sp.status.code, STATUS.ERROR);
  assert.equal(sp.status.message.length, 300); // truncated
  await t.shutdown();
});

test('child span inherits trace id and links parentSpanId', async () => {
  const fetchFn = recordingFetch();
  const t = createTracer({ serviceName: 'tree', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000 });
  const rootSpan = t.startSpan('server', { kind: SPAN_KIND.SERVER });
  const child = t.startSpan('client', { kind: SPAN_KIND.CLIENT, parent: rootSpan });
  assert.equal(child.traceId, rootSpan.traceId);
  assert.equal(child.parentSpanId, rootSpan.spanId);
  t.endSpan(child, { status: STATUS.OK });
  t.endSpan(rootSpan, { status: STATUS.OK });
  await t.flush();
  const spans = fetchFn.calls[0].body.resourceSpans[0].scopeSpans[0].spans;
  const out = spans.find((s) => s.name === 'client');
  assert.equal(out.parentSpanId, rootSpan.spanId);
  assert.equal(out.traceId, rootSpan.traceId);
  await t.shutdown();
});

/* ------------------------------------------------------------------ propagation */
test('cross-service propagation keeps one continuous trace', () => {
  // service A (e.g. stream-bridge) creates a SERVER root + CLIENT child, injects.
  const a = createTracer({ serviceName: 'bridge', endpoint: 'http://c:4318', fetchFn: recordingFetch(), flushIntervalMs: 60000 });
  const aServer = a.startSpan('bridge POST /v1/chat/completions', { kind: SPAN_KIND.SERVER });
  const aClient = a.startSpan('runtime /v1/rate-limit', { kind: SPAN_KIND.CLIENT, parent: aServer });
  const headers = a.inject({ 'Content-Type': 'application/json' }, aClient);
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  // service B (e.g. platform-runtime) extracts and starts a child SERVER span.
  const b = createTracer({ serviceName: 'runtime', endpoint: 'http://c:4318', fetchFn: recordingFetch(), flushIntervalMs: 60000 });
  const ctx = b.extract(headers);
  assert.ok(ctx, 'B must extract a valid context');
  const bServer = b.startSpan('runtime POST /v1/rate-limit', { kind: SPAN_KIND.SERVER, parent: ctx });
  assert.equal(bServer.traceId, aServer.traceId, 'same trace across services');
  assert.equal(bServer.traceId, aClient.traceId);
  assert.equal(bServer.parentSpanId, aClient.spanId, 'B server is child of A client');
  // extract is case-insensitive on the header key
  assert.deepEqual(b.extract({ Traceparent: headers.traceparent }), ctx);
});

test('extract returns null when no/invalid traceparent (root starts fresh)', () => {
  const t = createTracer({ serviceName: 'x', endpoint: 'http://c:4318', fetchFn: recordingFetch() });
  assert.equal(t.extract({}), null);
  assert.equal(t.extract({ traceparent: 'bad' }), null);
  const s = t.startSpan('fresh', { parent: t.extract({}) });
  assert.match(s.traceId, /^[0-9a-f]{32}$/);
  assert.equal(s.parentSpanId, '');
});

/* ------------------------------------------------------------------ fail-open NEGATIVE CONTROLS */
test('fail-open: a throwing collector never throws into the host and drains the buffer', async () => {
  const fetchFn = recordingFetch(() => { throw new Error('ECONNREFUSED'); });
  const t = createTracer({ serviceName: 'fo', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000 });
  t.endSpan(t.startSpan('s1'), { status: STATUS.OK });
  assert.equal(t._buffer.length, 1);
  await assert.doesNotReject(t.flush()); // must NOT throw
  assert.equal(fetchFn.calls.length, 1); // it tried
  assert.equal(t._buffer.length, 0); // dropped, not wedged
  // a subsequent span still buffers and flushes (tracer not permanently broken)
  t.endSpan(t.startSpan('s2'), { status: STATUS.OK });
  await assert.doesNotReject(t.flush());
  assert.equal(fetchFn.calls.length, 2);
  await t.shutdown();
});

test('fail-open: a rejecting collector (non-2xx) is dropped, not retried into the request', async () => {
  const fetchFn = recordingFetch({ ok: false, status: 503 });
  const t = createTracer({ serviceName: 'fo', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000 });
  t.endSpan(t.startSpan('s'), { status: STATUS.OK });
  await assert.doesNotReject(t.flush());
  assert.equal(t._buffer.length, 0);
  await t.shutdown();
});

test('fail-open: a timing-out collector is swallowed', async () => {
  const fetchFn = recordingFetch(() => { throw new DOMException('The operation was aborted', 'TimeoutError'); });
  const t = createTracer({ serviceName: 'fo', endpoint: 'http://c:4318', fetchFn, flushIntervalMs: 60000, timeoutMs: 5 });
  t.endSpan(t.startSpan('s'), { status: STATUS.OK });
  await assert.doesNotReject(t.flush());
  assert.equal(t._buffer.length, 0);
  await t.shutdown();
});

test('disabled tracer never calls fetch even with a recorder present', async () => {
  const fetchFn = recordingFetch();
  const t = createTracer({ serviceName: 'off', fetchFn }); // no endpoint => disabled
  t.endSpan(t.startSpan('s'), { status: STATUS.OK });
  await t.flush();
  await t.shutdown();
  assert.equal(fetchFn.calls.length, 0);
});

/* ------------------------------------------------------------------ drift guard */
test('drift guard: canonical + both vendored copies are byte-identical', () => {
  const canonicalBytes = readFileSync(join(here, 'tracer.js'));
  const bridgeBytes = readFileSync(join(root, 'stream-bridge', 'tracer.js'));
  const runtimeBytes = readFileSync(join(root, 'platform-runtime', 'tracer.cjs'));
  const h = sha(canonicalBytes);
  assert.equal(sha(bridgeBytes), h, 'stream-bridge/tracer.js drifted from canonical');
  assert.equal(sha(runtimeBytes), h, 'platform-runtime/tracer.cjs drifted from canonical');
  assert.ok(canonicalBytes.equals(bridgeBytes));
  assert.ok(canonicalBytes.equals(runtimeBytes));
});

test('each vendored copy is functional in its own module context', () => {
  // bridge copy is CJS .js (no package.json there); runtime copy is .cjs (package
  // is type:module). Loading each proves the extension/rename actually works.
  const bridgeRequire = createRequire(join(root, 'stream-bridge', 'server.js'));
  const bridgeTracer = bridgeRequire('./tracer.js');
  const runtimeRequire = createRequire(join(root, 'platform-runtime', 'server.js'));
  const runtimeTracer = runtimeRequire('./tracer.cjs');
  for (const mod of [bridgeTracer, runtimeTracer]) {
    assert.equal(typeof mod.createTracer, 'function');
    const t = mod.createTracer({ serviceName: 'copy', endpoint: 'http://c:4318', fetchFn: recordingFetch(), flushIntervalMs: 60000 });
    const s = t.startSpan('probe', { kind: mod.SPAN_KIND.SERVER });
    t.endSpan(s, { status: mod.STATUS.OK });
    assert.equal(t._buffer.length, 1);
    assert.match(t.traceparent(s), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  }
});