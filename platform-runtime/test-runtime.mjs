#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.PLATFORM_RUNTIME_URL || 'http://localhost:3220').replace(/\/$/, '');
const KEY = process.env.PLATFORM_RUNTIME_KEY || process.env.CHAT_API_KEY || '';
if (!KEY) {
  console.error('PLATFORM_RUNTIME_KEY is required');
  process.exit(2);
}

const call = async (path, body) => {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-platform-runtime-key': KEY },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const health = await fetch(BASE + '/healthz');
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);

const scope = 'runtime-test-' + Date.now();
const key = 'same-key';
const requestId = randomUUID();
const attempts = await Promise.all(Array.from({ length: 20 }, () => call('/v1/idempotency/admit', {
  scope, idempotency_key: key, request_id: requestId, trace_id: randomUUID().replaceAll('-', ''),
})));
assert.equal(attempts.filter((x) => x.body.admitted === true).length, 1);
assert.equal(attempts.filter((x) => x.body.in_flight === true).length + attempts.filter((x) => x.body.replayed === true).length, 19);

const completed = await call('/v1/idempotency/complete', { scope, idempotency_key: key, request_id: requestId, result: { todo_id: 42 } });
assert.equal(completed.body.persisted, true);
const replay = await call('/v1/idempotency/admit', { scope, idempotency_key: key });
assert.equal(replay.body.replayed, true);
assert.deepEqual(replay.body.result, { todo_id: 42 });

const rate = await Promise.all(Array.from({ length: 5 }, () => call('/v1/rate-limit', { scope, limit: 3, window_sec: 60 })));
assert.equal(rate.filter((x) => x.body.allowed).length, 3);

const lockA = await call('/v1/locks/acquire', { resource: scope, ttl_ms: 5000 });
assert.equal(lockA.body.acquired, true);
const lockB = await call('/v1/locks/acquire', { resource: scope, ttl_ms: 5000 });
assert.equal(lockB.body.acquired, false);
const released = await call('/v1/locks/release', { resource: scope, token: lockA.body.token });
assert.equal(released.body.released, true);

const unknownScope = scope + '-unknown';
const unknownRequest = randomUUID();
const unknownAdmit = await call('/v1/idempotency/admit', { scope: unknownScope, idempotency_key: key, request_id: unknownRequest });
assert.equal(unknownAdmit.body.admitted, true);
const markedUnknown = await call('/v1/idempotency/unknown', {
  scope: unknownScope,
  idempotency_key: key,
  request_id: unknownRequest,
  error_code: 'write_timeout',
});
assert.equal(markedUnknown.body.state, 'UNKNOWN');
const unknownReplay = await call('/v1/idempotency/admit', { scope: unknownScope, idempotency_key: key, request_id: randomUUID() });
assert.equal(unknownReplay.body.unknown, true);

const settledUnknownScope = scope + '-settled-unknown';
const settledUnknownRequest = randomUUID();
await call('/v1/idempotency/admit', { scope: settledUnknownScope, idempotency_key: key, request_id: settledUnknownRequest });
await call('/v1/idempotency/unknown', {
  scope: settledUnknownScope,
  idempotency_key: key,
  request_id: settledUnknownRequest,
  result: { id: 43, text: 'known write result' },
});
const settledReplay = await call('/v1/idempotency/admit', { scope: settledUnknownScope, idempotency_key: key, request_id: randomUUID() });
assert.equal(settledReplay.body.replayed, true);
assert.deepEqual(settledReplay.body.result, { id: 43, text: 'known write result' });

const jobScope = scope + '-job';
const jobRequest = randomUUID();
const jobId = 'runtime-job-' + Date.now();
await call('/v1/requests/start', { request_id: jobRequest, trace_id: randomUUID().replaceAll('-', ''), scope: jobScope, idempotency_key: 'job-key' });
const enqueued = await call('/v1/jobs/enqueue', {
  job_id: jobId,
  job_type: 'kb_save',
  request_id: jobRequest,
  trace_id: randomUUID().replaceAll('-', ''),
  scope: jobScope,
  idempotency_key: 'job-key',
  payload: { mode: 'ingest', title: 'runtime-test', text: 'runtime-test' },
});
assert.equal(enqueued.body.accepted, true);
const attemptOne = await call('/v1/jobs/attempt', { job_id: jobId });
assert.equal(attemptOne.body.attempts, 1);
const retry = await call('/v1/jobs/retry', { job_id: jobId, error_code: 'temporary_failure' });
assert.equal(retry.body.status, 'RETRY_WAITING');
const attemptTwo = await call('/v1/jobs/attempt', { job_id: jobId });
assert.equal(attemptTwo.body.attempts, 2);
const jobComplete = await call('/v1/jobs/complete', { job_id: jobId, status: 'SUCCEEDED', result: { doc_id: 'runtime-test' } });
assert.equal(jobComplete.body.status, 'SUCCEEDED');
const terminalAttempt = await call('/v1/jobs/attempt', { job_id: jobId });
assert.equal(terminalAttempt.body.terminal, true);

console.log('platform-runtime contract OK');
