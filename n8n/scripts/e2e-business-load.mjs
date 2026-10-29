#!/usr/bin/env node

/*
 * Read-only end-to-end business baseline.
 *
 * The requests cross the host -> n8n webhook -> workflow -> Postgres/Data
 * Tables path. No model call and no business write is performed. Runtime
 * coordination has its own load test in platform-runtime/load-test.mjs.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/e2e-business-load.mjs
 *   E2E_REQUESTS_PER_ENDPOINT=50 E2E_CONCURRENCY=10 node --env-file=.env n8n/scripts/e2e-business-load.mjs
 */

const BASE = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const REQUESTS_PER_ENDPOINT = Math.max(1, Number(process.env.E2E_REQUESTS_PER_ENDPOINT || 20));
const CONCURRENCY = Math.max(1, Number(process.env.E2E_CONCURRENCY || 5));
const TIMEOUT_MS = Math.max(1000, Number(process.env.E2E_TIMEOUT_MS || 30000));

if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required');
  process.exit(2);
}

const endpoints = [
  {
    name: 'chat_stats',
    path: '/webhook/v1/stats/executions',
    validate: (body) => body?.totals && typeof body.totals.total === 'number' && Array.isArray(body.recent),
  },
  {
    name: 'platform_overview',
    path: '/webhook/admin/overview',
    validate: (body) => body?.ok === true && body?.chat_24h && typeof body.chat_24h.total === 'number' && body.alerts,
  },
  {
    name: 'platform_settings',
    path: '/webhook/admin/settings',
    validate: (body) => body?.ok === true && body.alerts && body.cost && body.embedding,
  },
  {
    name: 'people',
    path: '/webhook/admin/people',
    validate: (body) => body?.ok === true && typeof body.count === 'number' && Array.isArray(body.people),
  },
  {
    name: 'todos',
    path: '/webhook/admin/todos',
    validate: (body) => body?.ok === true && typeof body.assigned_count === 'number' && Array.isArray(body.open),
  },
];

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
};

const call = async (endpoint) => {
  const started = performance.now();
  try {
    const response = await fetch(BASE + endpoint.path, {
      headers: { Authorization: `Bearer ${CHAT_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    return {
      status: response.status,
      shape_ok: response.ok && endpoint.validate(body),
      ms: performance.now() - started,
    };
  } catch (error) {
    return { status: 0, shape_ok: false, error: String(error?.message || error), ms: performance.now() - started };
  }
};

const runBatch = async (endpoint) => {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= REQUESTS_PER_ENDPOINT) return;
      results[index] = await call(endpoint);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS_PER_ENDPOINT) }, worker));

  const statuses = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] || 0) + 1;
  const success = results.filter((result) => result.status >= 200 && result.status < 300).length;
  const transportErrors = results.filter((result) => result.status === 0).length;
  const shapeErrors = results.filter((result) => !result.shape_ok).length;
  const times = results.map((result) => result.ms);
  return {
    name: endpoint.name,
    path: endpoint.path,
    requests: results.length,
    success,
    success_rate: Math.round((success / results.length) * 10000) / 100,
    transport_errors: transportErrors,
    shape_errors: shapeErrors,
    statuses,
    p50_ms: Math.round(percentile(times, 0.5) * 100) / 100,
    p95_ms: Math.round(percentile(times, 0.95) * 100) / 100,
    max_ms: Math.round(Math.max(...times) * 100) / 100,
  };
};

const started = new Date().toISOString();
const reports = [];
for (const endpoint of endpoints) reports.push(await runBatch(endpoint));

const totalRequests = reports.reduce((sum, report) => sum + report.requests, 0);
const totalSuccess = reports.reduce((sum, report) => sum + report.success, 0);
const totalTransportErrors = reports.reduce((sum, report) => sum + report.transport_errors, 0);
const totalShapeErrors = reports.reduce((sum, report) => sum + report.shape_errors, 0);
const result = {
  test: 'e2e-business-load',
  started_at: started,
  finished_at: new Date().toISOString(),
  base_url: BASE,
  config: { requests_per_endpoint: REQUESTS_PER_ENDPOINT, concurrency: CONCURRENCY, timeout_ms: TIMEOUT_MS },
  safety: { model_calls: 0, business_writes: 0 },
  totals: {
    requests: totalRequests,
    success: totalSuccess,
    success_rate: Math.round((totalSuccess / totalRequests) * 10000) / 100,
    transport_errors: totalTransportErrors,
    shape_errors: totalShapeErrors,
  },
  endpoints: reports,
};

console.log(JSON.stringify(result, null, 2));
if (totalSuccess !== totalRequests || totalTransportErrors > 0 || totalShapeErrors > 0) process.exitCode = 1;
