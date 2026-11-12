#!/usr/bin/env node
/**
 * Disposable OTLP/JSON acceptance check for the agent-platform tracing pipeline.
 *
 * What it proves (end-to-end, against REAL containers — not a mock):
 *   1. The canonical hand-rolled tracer (monitoring/otel/tracer.js) emits an
 *      OTLP/HTTP **JSON** payload that a real otel-collector accepts (HTTP 200).
 *   2. The collector forwards it over OTLP/gRPC to a real Jaeger, which stores
 *      it and serves it back through the query API.
 *   3. A cross-service span tree survives propagation: a stream-bridge SERVER
 *      root -> bridge CLIENT -> platform-runtime SERVER, all under one traceId,
 *      with the correct CHILD_OF links and two distinct service names.
 *   4. Negative control: a malformed OTLP body is rejected (4xx), so the 200 in
 *      (1) is meaningful — the receiver is validating, not blanket-accepting.
 *
 * Isolation: this NEVER touches the shared stack. It creates a throwaway network
 * (otel-verify-net) and two throwaway containers (otel-verify-collector /
 * otel-verify-jaeger) on host-loopback ports 14318/14313/16687, then removes them
 * in a finally-style cleanup even on failure. Same precedent as the disposable
 * pg_search BM25 syntax check.
 *
 * Usage:
 *   node monitoring/otel/otlp-acceptance.mjs
 *   DOCKER_BIN=/path/to/docker node monitoring/otel/otlp-acceptance.mjs   # if docker not on PATH
 *
 * Images must already be present locally (the script fails fast rather than
 * hanging on a pull):
 *   docker pull otel/opentelemetry-collector:0.115.0
 *   docker pull jaegertracing/all-in-one:1.62.0
 *
 * This is a pre-deploy sanity check. Live cross-service continuity into n8n
 * (incoming traceparent extraction) is a SEPARATE, operator-run gate on the
 * deployment machine with `docker compose --profile tracing up -d` and real
 * traffic — see monitoring/otel-tracing-2026-11-12.md. Offline/this green is not
 * that acceptance.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The REAL canonical tracer — not a reimplementation.
const { createTracer, SPAN_KIND, STATUS } = require('./tracer.js');

const DOCKER = process.env.DOCKER_BIN || 'docker';
const NET = 'otel-verify-net';
const COLLECTOR = 'otel-verify-collector';
const JAEGER = 'otel-verify-jaeger';
const HTTP_PORT = String(process.env.OTEL_VERIFY_HTTP_PORT || 14318);
const HEALTH_PORT = String(process.env.OTEL_VERIFY_HEALTH_PORT || 14313);
const UI_PORT = String(process.env.OTEL_VERIFY_UI_PORT || 16687);
const COLLECTOR_IMAGE = process.env.OTEL_VERIFY_COLLECTOR_IMAGE || 'otel/opentelemetry-collector:0.115.0';
const JAEGER_IMAGE = process.env.OTEL_VERIFY_JAEGER_IMAGE || 'jaegertracing/all-in-one:1.62.0';
const CONFIG = join(here, 'otel-collector-config.yaml');

let failures = 0;
const ok = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };
// Jaeger may strip leading zeros on hex ids; normalize before comparing.
const norm = (x) => (String(x == null ? '' : x).toLowerCase().replace(/^0+/, '') || '0');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function docker(args) { return spawnSync(DOCKER, args, { encoding: 'utf8' }); }
function dockerMust(args, label) {
  const r = docker(args);
  if (r.status !== 0) { console.error(`docker ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`); throw new Error(label); }
  return r.stdout;
}
async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}
function cleanup() {
  console.log('\ncleanup: removing throwaway containers + network');
  docker(['rm', '-f', COLLECTOR, JAEGER]);
  docker(['network', 'rm', NET]);
}

async function main() {
  const ver = docker(['version', '--format', '{{.Server.Version}}']);
  if (ver.status !== 0) { console.error('docker engine not reachable; set DOCKER_BIN if docker is not on PATH'); process.exit(2); }
  console.log(`docker engine ${ver.stdout.trim()}`);
  if (!existsSync(CONFIG)) { console.error(`missing collector config: ${CONFIG}`); process.exit(2); }
  for (const img of [COLLECTOR_IMAGE, JAEGER_IMAGE]) {
    if (docker(['image', 'inspect', img]).status !== 0) { console.error(`image ${img} not present locally; run: ${DOCKER} pull ${img}`); process.exit(2); }
  }
  console.log(`isolated net=${NET} collector=${COLLECTOR} jaeger=${JAEGER} host ports=${HTTP_PORT}(otlp)/${HEALTH_PORT}(health)/${UI_PORT}(ui)`);

  dockerMust(['network', 'create', NET], 'network create');
  dockerMust(['run', '-d', '--name', JAEGER, '--network', NET, '--network-alias', 'jaeger',
    '-e', 'COLLECTOR_OTLP_ENABLED=true', '-e', 'MEMORY_MAX_TRACES=50000',
    '-p', `127.0.0.1:${UI_PORT}:16686`, JAEGER_IMAGE], 'jaeger run');
  dockerMust(['run', '-d', '--name', COLLECTOR, '--network', NET,
    '-p', `127.0.0.1:${HTTP_PORT}:4318`, '-p', `127.0.0.1:${HEALTH_PORT}:13133`,
    '-v', `${CONFIG}:/etc/otelcol/config.yaml:ro`,
    COLLECTOR_IMAGE, '--config=/etc/otelcol/config.yaml'], 'collector run');

  const cReady = await waitFor(`http://127.0.0.1:${HEALTH_PORT}/`);
  ok(cReady, 'collector health_check reachable');
  const jReady = await waitFor(`http://127.0.0.1:${UI_PORT}/api/services`);
  ok(jReady, 'jaeger query API reachable');
  if (!cReady || !jReady) throw new Error('pipeline not ready');

  // --- generate a cross-service trace with the REAL canonical tracer ---
  const exportStatuses = [];
  const recFetch = async (url, init) => { const r = await fetch(url, init); exportStatuses.push(r.status); return r; };
  const endpoint = `http://127.0.0.1:${HTTP_PORT}`;
  const bridge = createTracer({ serviceName: 'stream-bridge', endpoint, fetchFn: recFetch, batchSize: 100, flushIntervalMs: 60000 });
  const runtime = createTracer({ serviceName: 'platform-runtime', endpoint, fetchFn: recFetch, batchSize: 100, flushIntervalMs: 60000 });
  ok(bridge.enabled && runtime.enabled, 'both tracers enabled (endpoint configured)');

  const root = bridge.startSpan('POST /v1/chat/completions', { kind: SPAN_KIND.SERVER, attributes: { 'http.method': 'POST', 'http.route': '/v1/chat/completions' } });
  const client = bridge.startSpan('runtime /v1/ratelimit', { kind: SPAN_KIND.CLIENT, parent: root, attributes: { 'rpc.system': 'http' } });
  const headers = bridge.inject({}, client);
  const ctx = runtime.extract(headers);
  ok(!!ctx && ctx.traceId === root.traceId, 'runtime extracted bridge trace context (same traceId)');
  const server = runtime.startSpan('POST /v1/ratelimit', { kind: SPAN_KIND.SERVER, parent: ctx, attributes: { 'http.method': 'POST' } });
  bridge.endSpan(client, { status: STATUS.OK });
  bridge.endSpan(root, { status: STATUS.OK });
  runtime.endSpan(server, { status: STATUS.OK });
  await bridge.shutdown();
  await runtime.shutdown();
  ok(exportStatuses.length === 2 && exportStatuses.every((s) => s === 200), `collector accepted OTLP/JSON (statuses=${JSON.stringify(exportStatuses)})`);

  // --- negative control: malformed OTLP must be rejected (proves 200 is meaningful) ---
  let badStatus = 0;
  try {
    const r = await fetch(`${endpoint}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"resourceSpans": [', signal: AbortSignal.timeout(3000) });
    badStatus = r.status;
  } catch { /* unreachable -> 0, will fail the assertion below */ }
  ok(badStatus >= 400 && badStatus < 500, `malformed OTLP body rejected (status=${badStatus})`);

  // --- query jaeger: the trace must land with the full cross-service tree ---
  const traceId = root.traceId;
  let trace = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${UI_PORT}/api/traces/${traceId}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { const j = await r.json(); if (j.data && j.data[0] && Array.isArray(j.data[0].spans) && j.data[0].spans.length >= 3) { trace = j.data[0]; break; } }
    } catch { /* not ingested yet */ }
    await sleep(700);
  }
  ok(!!trace, `trace ${traceId} landed in jaeger with >=3 spans`);
  if (trace) {
    const spans = trace.spans;
    const procs = trace.processes || {};
    const svc = (s) => (procs[s.processID] || {}).serviceName;
    const byName = (n) => spans.find((s) => s.operationName === n);
    const childOf = (s) => (s.references || []).find((r) => r.refType === 'CHILD_OF');
    const rootS = byName('POST /v1/chat/completions');
    const clientS = byName('runtime /v1/ratelimit');
    const serverS = byName('POST /v1/ratelimit');
    ok(spans.length === 3, `exactly 3 spans (got ${spans.length})`);
    ok(!!rootS && !!clientS && !!serverS, 'all three operation names present');
    ok(rootS && !childOf(rootS), 'root span has no parent');
    ok(clientS && rootS && childOf(clientS) && norm(childOf(clientS).spanID) === norm(rootS.spanID), 'bridge CLIENT is child of bridge SERVER');
    ok(serverS && clientS && childOf(serverS) && norm(childOf(serverS).spanID) === norm(clientS.spanID), 'runtime SERVER is child of bridge CLIENT (cross-service link)');
    const services = new Set(spans.map(svc));
    ok(services.size === 2 && services.has('stream-bridge') && services.has('platform-runtime'), `two services in one trace (${[...services].join(', ')})`);
    ok(rootS && svc(rootS) === 'stream-bridge', 'root span service = stream-bridge');
    ok(serverS && svc(serverS) === 'platform-runtime', 'runtime span service = platform-runtime');
    ok(spans.every((s) => norm(s.traceID) === norm(traceId)), 'all spans share the propagated traceId');
  }
}

main().then(() => {
  cleanup();
  console.log(`\n${failures === 0 ? 'ACCEPTANCE PASS' : 'ACCEPTANCE FAIL'} (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  console.error(`\nacceptance error: ${e.message}`);
  cleanup();
  process.exit(1);
});