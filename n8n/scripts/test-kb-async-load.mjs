#!/usr/bin/env node
/**
 * Phase 3.2 small async kb_save load.
 *
 * Submits temporary KB jobs, reads terminal state from Platform Runtime and
 * retires the created documents. This measures the real K8s Worker path.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/test-kb-async-load.mjs
 *   ASYNC_LOAD_COUNT=20 ASYNC_LOAD_CONCURRENCY=5 node --env-file=.env n8n/scripts/test-kb-async-load.mjs
 */

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const RUNTIME = (process.env.PLATFORM_RUNTIME_URL || 'http://127.0.0.1:13220').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const RUNTIME_KEY = process.env.PLATFORM_RUNTIME_KEY || CHAT_KEY;
const COUNT = Math.max(1, Number(process.env.ASYNC_LOAD_COUNT || 10));
const CONCURRENCY = Math.max(1, Math.min(COUNT, Number(process.env.ASYNC_LOAD_CONCURRENCY || 5)));
const TIMEOUT_MS = Math.max(1000, Number(process.env.ASYNC_LOAD_TIMEOUT_MS || 120000));
const POLL_MS = Math.max(100, Number(process.env.ASYNC_LOAD_POLL_MS || 500));

if (!CHAT_KEY) throw new Error('CHAT_API_KEY is required (use --env-file=.env)');

const runId = String(Date.now());
const startedAt = new Date().toISOString();
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 100) / 100;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postIngest = async (body, extra = {}) => {
  const response = await fetch(N8N + '/webhook/admin/kb/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CHAT_KEY, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  return { status: response.status, body: parsed };
};

const getJob = async (jobId) => {
  const response = await fetch(RUNTIME + '/v1/jobs/' + encodeURIComponent(jobId), {
    headers: { 'x-platform-runtime-key': RUNTIME_KEY },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || 'job query failed');
  return body.job;
};

const submit = async (index) => {
  const title = `phase3-2-kb-load-${runId}-${index}`;
  const idempotencyKey = `phase3-2-kb-load-${runId}-${index}`;
  const traceId = (runId + index).padStart(32, '0').slice(-32);
  const requestId = `phase3-2-kb-load-request-${runId}-${index}`;
  const started = performance.now();
  try {
    const response = await postIngest(
      { mode: 'ingest', title, text: `Phase 3.2 async load ${runId}-${index}.`, source_type: 'chat', idempotency_key: idempotencyKey },
      { 'x-idempotency-key': idempotencyKey, 'x-trace-id': traceId, 'x-request-id': requestId },
    );
    return { index, title, requestId, traceId, enqueueMs: performance.now() - started, ...response };
  } catch (error) {
    return { index, title, requestId, traceId, enqueueMs: performance.now() - started, status: 0, body: { error: String(error.message || error) } };
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
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
};

const waitForTerminal = async (item) => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const job = await getJob(item.body.task_id);
      if (['SUCCEEDED', 'FAILED'].includes(job.status)) {
        return { ...item, job, completionMs: performance.now() - item.startedAt };
      }
    } catch (error) {
      return { ...item, job: { status: 'QUERY_FAILED', error_message: String(error.message || error) } };
    }
    await sleep(POLL_MS);
  }
  return { ...item, job: { status: 'TIMEOUT' } };
};

const submissions = await batch(COUNT, async (index) => {
  const result = await submit(index);
  if (result.status === 202 && result.body?.task_id) result.startedAt = performance.now();
  return result;
});
const queued = submissions.filter((item) => item.status === 202 && item.body?.task_id);
const completed = await Promise.all(queued.map(waitForTerminal));
const succeeded = completed.filter((item) => item.job.status === 'SUCCEEDED');
const failed = completed.filter((item) => item.job.status === 'FAILED');
const timedOut = completed.filter((item) => item.job.status === 'TIMEOUT');
const queryFailed = completed.filter((item) => item.job.status === 'QUERY_FAILED');

const cleanup = [];
for (const item of succeeded) {
  const docId = item.job.result?.doc_id;
  if (!docId) {
    cleanup.push({ ok: false, error: 'missing doc_id', title: item.title });
    continue;
  }
  try {
    const result = await postIngest({ mode: 'retire', doc_id: docId });
    cleanup.push({ ok: result.status === 200 && result.body?.ok === true, title: item.title });
  } catch (error) {
    cleanup.push({ ok: false, error: String(error.message || error), title: item.title });
  }
}

const enqueueTimes = submissions.map((item) => item.enqueueMs);
const completionTimes = succeeded.map((item) => item.completionMs);
const result = {
  ok: queued.length === COUNT && succeeded.length === COUNT && cleanup.every((item) => item.ok),
  test: 'kb-async-load',
  run_id: runId,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  config: { count: COUNT, concurrency: CONCURRENCY, timeout_ms: TIMEOUT_MS, poll_ms: POLL_MS },
  submissions: { total: COUNT, queued: queued.length, rejected: COUNT - queued.length },
  jobs: { succeeded: succeeded.length, failed: failed.length, timed_out: timedOut.length, query_failed: queryFailed.length },
  latency_ms: {
    enqueue_p50: percentile(enqueueTimes, 0.5),
    enqueue_p95: percentile(enqueueTimes, 0.95),
    completion_p50: percentile(completionTimes, 0.5),
    completion_p95: percentile(completionTimes, 0.95),
    completion_max: completionTimes.length ? Math.round(Math.max(...completionTimes) * 100) / 100 : 0,
  },
  cleanup: { attempted: cleanup.length, succeeded: cleanup.filter((item) => item.ok).length, failed: cleanup.filter((item) => !item.ok).length },
  safety: { model_calls: 0, permanent_test_documents: 0 },
  task_ids: queued.map((item) => item.body.task_id),
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
