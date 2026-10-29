#!/usr/bin/env node

const BASE = (process.env.PLATFORM_RUNTIME_URL || 'http://127.0.0.1:3220').replace(/\/$/, '');
const KEY = process.env.PLATFORM_RUNTIME_KEY || process.env.CHAT_API_KEY || '';
const REQUESTS = Math.max(10, Number(process.env.LOAD_REQUESTS || 200));
const CONCURRENCY = Math.max(1, Number(process.env.LOAD_CONCURRENCY || 50));
const RATE_REQUESTS = Math.max(10, Number(process.env.LOAD_RATE_REQUESTS || 100));
const RATE_LIMIT = Math.max(1, Number(process.env.LOAD_RATE_LIMIT || Math.floor(RATE_REQUESTS / 2)));
const timeoutMs = Math.max(1000, Number(process.env.LOAD_TIMEOUT_MS || 5000));

if (!KEY) {
  console.error('PLATFORM_RUNTIME_KEY or CHAT_API_KEY is required');
  process.exit(2);
}

const headers = { 'content-type': 'application/json', 'x-platform-runtime-key': KEY };
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
};
const request = async (path, body) => {
  const started = performance.now();
  try {
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json(), ms: performance.now() - started };
  } catch (error) {
    return { status: 0, body: { ok: false, error: String(error.message || error) }, ms: performance.now() - started };
  }
};
const batch = async (count, fn) => {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      results[index] = await fn(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
  return results;
};
const summary = (name, results) => ({
  name,
  requests: results.length,
  ok: results.filter((r) => r.status >= 200 && r.status < 300).length,
  errors: results.filter((r) => r.status === 0 || r.status >= 500).length,
  p50_ms: Math.round(percentile(results.map((r) => r.ms), 0.5) * 100) / 100,
  p95_ms: Math.round(percentile(results.map((r) => r.ms), 0.95) * 100) / 100,
  max_ms: Math.round(Math.max(...results.map((r) => r.ms)) * 100) / 100,
});

const run = async () => {
  const runId = `load-${Date.now()}`;
  const idemKey = `${runId}-idem`;
  const idemResults = await batch(REQUESTS, () => request('/v1/idempotency/admit', {
    scope: `load:${runId}`,
    idempotency_key: idemKey,
    request_id: `${runId}-request`,
    trace_id: 'd'.repeat(32),
  }));
  const admitted = idemResults.filter((r) => r.body.admitted === true).length;
  const inFlightOrReplay = idemResults.filter((r) => r.body.in_flight || r.body.replayed).length;
  await request('/v1/idempotency/complete', {
    scope: `load:${runId}`,
    idempotency_key: idemKey,
    request_id: `${runId}-request`,
    result: { load_test: true },
  });

  const rateResults = await batch(RATE_REQUESTS, (index) => request('/v1/rate-limit', {
    scope: `load:${runId}:rate`,
    limit: RATE_LIMIT,
    window_sec: 60,
    request_id: `${runId}-rate-${index}`,
  }));
  const rateAllowed = rateResults.filter((r) => r.body.allowed === true).length;
  const rateBlocked = rateResults.filter((r) => r.body.allowed === false).length;

  const lockResults = await batch(REQUESTS, (index) => request('/v1/locks/acquire', {
    resource: `load:${runId}:lock`,
    token: `${runId}-token-${index}`,
    ttl_ms: 5000,
  }));
  const locksAcquired = lockResults.filter((r) => r.body.acquired === true);
  if (locksAcquired[0]?.body.token) {
    await request('/v1/locks/release', { resource: `load:${runId}:lock`, token: locksAcquired[0].body.token });
  }

  const report = {
    base_url: BASE,
    config: { requests: REQUESTS, concurrency: CONCURRENCY, rate_requests: RATE_REQUESTS, rate_limit: RATE_LIMIT },
    idempotency: { ...summary('idempotency_admit', idemResults), admitted, in_flight_or_replayed: inFlightOrReplay },
    rate_limit: { ...summary('rate_limit', rateResults), allowed: rateAllowed, blocked: rateBlocked },
    lock: { ...summary('lock_acquire', lockResults), acquired: locksAcquired.length },
  };
  console.log(JSON.stringify(report, null, 2));

  const failed = admitted !== 1 || inFlightOrReplay !== REQUESTS - 1 || rateAllowed !== RATE_LIMIT || rateBlocked !== RATE_REQUESTS - RATE_LIMIT || locksAcquired.length !== 1;
  if (failed) process.exitCode = 1;
};

await run();
