import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const STREAM = process.env.JOB_STREAM || 'platform:jobs';
const GROUP = process.env.JOB_GROUP || 'platform-kb-workers';
const CONSUMER = process.env.JOB_CONSUMER || `worker-${process.pid}`;
const N8N_URL = (process.env.N8N_URL || 'http://n8n:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const RUNTIME_URL = (process.env.PLATFORM_RUNTIME_URL || 'http://platform-runtime:3220').replace(/\/$/, '');
const RUNTIME_KEY = process.env.PLATFORM_RUNTIME_KEY || CHAT_KEY;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.JOB_MAX_ATTEMPTS || 3));
const CLAIM_IDLE_MS = Math.max(1000, Number(process.env.JOB_CLAIM_IDLE_MS || 120000));
const CLAIM_COUNT = Math.max(1, Number(process.env.JOB_CLAIM_COUNT || 10));

const redis = createClient({ url: REDIS_URL });
redis.on('error', (error) => console.error('[worker] redis error', error.message));

const runtimePost = async (path, body) => {
  const response = await fetch(RUNTIME_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-platform-runtime-key': RUNTIME_KEY },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(path + ': ' + JSON.stringify(result));
  return result;
};

const runKbSave = async (job) => {
  const payload = JSON.parse(job.payload || '{}');
  const response = await fetch(N8N_URL + '/webhook/admin/kb/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + CHAT_KEY,
      'Content-Type': 'application/json',
      'x-platform-worker': '1',
      'x-trace-id': job.trace_id || '',
      'x-request-id': job.request_id || '',
    },
    body: JSON.stringify({ ...payload, source_type: 'async-worker' }),
  });
  const result = await response.json();
  const ok = response.ok && result && result.ok !== false && !result.error;
  const status = ok ? 200 : Math.max(400, response.status || 503);
  const errorText = String(result?.error || result?.detail || '').toLowerCase();
  const transportFailure = /socket hang up|fetch failed|econnreset|etimedout|timeout|temporarily unavailable/.test(errorText);
  const retryable = !ok && (status === 408 || status === 425 || status === 429 || status >= 500 || transportFailure);
  return { ok, status, retryable, result };
};

const handle = async (message) => {
  const fields = message.message;
  if (fields.job_type !== 'kb_save') {
    await redis.xAck(STREAM, GROUP, message.id);
    return;
  }
  const attempt = await runtimePost('/v1/jobs/attempt', { job_id: fields.job_id });
  if (attempt.terminal) {
    await redis.xAck(STREAM, GROUP, message.id);
    return;
  }
  let outcome;
  try {
    outcome = await runKbSave(fields);
  } catch (error) {
    outcome = { ok: false, status: 503, retryable: true, result: { ok: false, status: 503, error: String(error.message || error).slice(0, 300) } };
  }
  if (!outcome.ok && outcome.retryable && Number(attempt.attempts || 1) < MAX_ATTEMPTS) {
    await runtimePost('/v1/jobs/retry', {
      job_id: fields.job_id,
      error_code: 'kb_async_retryable_failure',
      error_message: String(outcome.result?.error || 'retryable async KB save failure').slice(0, 300),
    });
    console.log(JSON.stringify({ event: 'job.retry', job_id: fields.job_id, attempt: attempt.attempts, max_attempts: MAX_ATTEMPTS }));
    return;
  }
  await runtimePost('/v1/jobs/complete', {
    job_id: fields.job_id,
    status: outcome.ok ? 'SUCCEEDED' : 'FAILED',
    result: outcome.result,
    error_code: outcome.ok ? '' : 'kb_async_failed',
    error_message: outcome.ok ? '' : String(outcome.result?.error || 'async KB save failed').slice(0, 300),
  });
  await redis.xAck(STREAM, GROUP, message.id);
  console.log(JSON.stringify({ event: 'job.complete', job_id: fields.job_id, status: outcome.ok ? 'SUCCEEDED' : 'FAILED' }));
};

const claimPending = async () => {
  let cursor = '0-0';
  do {
    const claimed = await redis.xAutoClaim(STREAM, GROUP, CONSUMER, CLAIM_IDLE_MS, cursor, { COUNT: CLAIM_COUNT });
    cursor = claimed.nextId;
    for (const message of claimed.messages || []) {
      try { await handle(message); }
      catch (error) { console.error('[worker] claimed job failed', message.id, error.message); }
    }
  } while (cursor !== '0-0' && cursor);
};

await redis.connect();
await redis.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true }).catch((error) => {
  if (!String(error.message || error).includes('BUSYGROUP')) throw error;
});
console.log(`[worker] listening stream=${STREAM} group=${GROUP} consumer=${CONSUMER}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await redis.quit().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

while (!stopping) {
  await claimPending();
  const streams = await redis.xReadGroup(GROUP, CONSUMER, [{ key: STREAM, id: '>' }], { COUNT: 1, BLOCK: 5000 });
  for (const stream of streams || []) {
    for (const message of stream.messages || []) {
      try { await handle(message); }
      catch (error) { console.error('[worker] job failed', message.id, error.message); }
    }
  }
}
