import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3220);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
// Reuse the gateway key by default so a fresh stack does not need a second secret.
const RUNTIME_KEY = String(process.env.PLATFORM_RUNTIME_KEY || process.env.CHAT_API_KEY || '').trim();
const IDEM_TTL = Math.max(1, Number(process.env.IDEMPOTENCY_WINDOW_SEC || 300));
const JOB_TTL = Math.max(300, Number(process.env.PLATFORM_JOB_TTL_SEC || 86400));
const JOB_STREAM = process.env.JOB_STREAM || 'platform:jobs';
const DEFAULT_RPM = Math.max(1, Number(process.env.PLATFORM_RATE_LIMIT_RPM || 60));
const STATE_ENABLED = String(process.env.PLATFORM_STATE_ENABLED || 'true').toLowerCase() !== 'false';
const DB = {
  host: process.env.DB_POSTGRESDB_HOST || 'postgres',
  port: Number(process.env.DB_POSTGRESDB_PORT || 5432),
  database: process.env.DB_POSTGRESDB_DATABASE || 'n8n',
  user: process.env.DB_POSTGRESDB_USER || 'n8n',
  password: process.env.DB_POSTGRESDB_PASSWORD || '',
};

const redis = createClient({ url: REDIS_URL });
redis.on('error', (error) => console.error('[runtime] redis error', error.message));
const db = new Pool({ ...DB, max: 5, connectionTimeoutMillis: 1000, query_timeout: 3000 });
db.on('error', (error) => console.error('[runtime] postgres error', error.message));

const metrics = {
  http_requests_total: 0,
  http_errors_total: 0,
  idempotency_admitted_total: 0,
  idempotency_replayed_total: 0,
  idempotency_unknown_total: 0,
  jobs_enqueued_total: 0,
  jobs_retried_total: 0,
  jobs_completed_total: 0,
  jobs_failed_total: 0,
  rate_limited_total: 0,
  locks_acquired_total: 0,
  locks_contended_total: 0,
  state_transitions_total: 0,
  state_store_errors_total: 0,
};
const LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const requestLatency = {
  sum_ms: 0,
  count: 0,
  buckets: Object.fromEntries(LATENCY_BUCKETS.map((bucket) => [bucket, 0])),
};

const bump = (name) => { metrics[name] = Number(metrics[name] || 0) + 1; };
const observeRequest = (durationMs) => {
  requestLatency.sum_ms += durationMs;
  requestLatency.count += 1;
  for (const bucket of LATENCY_BUCKETS) if (durationMs <= bucket) requestLatency.buckets[bucket] += 1;
};
const metricText = () => [
  '# HELP platform_runtime_info Runtime build and dependency state.',
  '# TYPE platform_runtime_info gauge',
  `platform_runtime_info{redis_ready="${redis.isReady}",state_enabled="${STATE_ENABLED}"} 1`,
  ...Object.entries(metrics).map(([name, value]) => `# TYPE ${name} counter\n${name} ${value}`),
  '# HELP platform_runtime_request_duration_ms Runtime HTTP request duration.',
  '# TYPE platform_runtime_request_duration_ms histogram',
  ...LATENCY_BUCKETS.map((bucket) => `platform_runtime_request_duration_ms_bucket{le="${bucket}"} ${requestLatency.buckets[bucket]}`),
  `platform_runtime_request_duration_ms_bucket{le="+Inf"} ${requestLatency.count}`,
  `platform_runtime_request_duration_ms_sum ${requestLatency.sum_ms}`,
  `platform_runtime_request_duration_ms_count ${requestLatency.count}`,
].join('\n') + '\n';

const traceId = (value) => {
  const candidate = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : crypto.randomUUID().replaceAll('-', '');
};
const requestId = (value) => String(value || '').trim().slice(0, 120) || crypto.randomUUID();
const stateNames = new Set(['RECEIVED', 'VALIDATED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_RETRY', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
const transitions = {
  RECEIVED: ['VALIDATED', 'RUNNING', 'FAILED'],
  VALIDATED: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'WAITING_APPROVAL', 'WAITING_RETRY'],
  WAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  WAITING_RETRY: ['RUNNING', 'FAILED', 'TIMED_OUT'],
};

const LOCK_RELEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const RATE_LIMIT = `
local count = redis.call('incr', KEYS[1])
if count == 1 then redis.call('expire', KEYS[1], ARGV[2]) end
return count
`;

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid JSON'); }
};

const authOk = (req) => {
  if (!RUNTIME_KEY) return false;
  const provided = String(req.headers['x-platform-runtime-key'] || '').trim();
  if (provided.length !== RUNTIME_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(RUNTIME_KEY));
};

const keyPart = (value, fallback = 'anonymous') => String(value || fallback).replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 180);

async function transitionRequest(body) {
  if (!STATE_ENABLED) return { ok: true, persisted: false, state_store: 'disabled' };
  const id = requestId(body.request_id);
  const trace = traceId(body.trace_id);
  const scope = keyPart(body.scope, 'default');
  const nextState = String(body.to_state || body.state || '').toUpperCase();
  if (!stateNames.has(nextState)) return { ok: false, error: 'invalid_state' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT state, attempt FROM platform.requests WHERE request_id = $1 FOR UPDATE',
      [id],
    );
    const current = currentResult.rows[0];
    let fromState = current?.state || null;
    if (current && current.state !== nextState && !(transitions[current.state] || []).includes(nextState)) {
      await client.query('ROLLBACK');
      return { ok: false, persisted: false, error: 'invalid_transition', from_state: current.state, to_state: nextState };
    }
    if (!current) {
      if (!['RECEIVED', 'VALIDATED', 'RUNNING'].includes(nextState)) {
        await client.query('ROLLBACK');
        return { ok: false, persisted: false, error: 'initial_state_must_be_active', to_state: nextState };
      }
      await client.query(
        `INSERT INTO platform.requests
          (request_id, trace_id, scope, session_id, idempotency_key, state, attempt, deadline_at, error_code, error_message, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, trace, scope, String(body.session_id || '').slice(0, 200), body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null,
          nextState, Math.max(0, Number(body.attempt || 0)), body.deadline_at || null, body.error_code || null, body.error_message || null, body.result || null],
      );
    } else if (current.state !== nextState) {
      await client.query(
        `UPDATE platform.requests SET state = $2, trace_id = $3, updated_at = now(),
          error_code = COALESCE($4, error_code), error_message = COALESCE($5, error_message),
          result = COALESCE($6, result), completed_at = CASE WHEN $2 IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED') THEN now() ELSE completed_at END
         WHERE request_id = $1`,
        [id, nextState, trace, body.error_code || null, body.error_message || null, body.result || null],
      );
    }
    await client.query(
      `INSERT INTO platform.events (request_id, trace_id, event_type, from_state, to_state, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, trace, String(body.event_type || 'state.transition').slice(0, 120), fromState, nextState, body.payload || body.result || null],
    );
    await client.query('COMMIT');
    bump('state_transitions_total');
    return { ok: true, persisted: true, request_id: id, trace_id: trace, from_state: fromState, state: nextState };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    bump('state_store_errors_total');
    throw error;
  } finally {
    client.release();
  }
}

async function startRequest(body) {
  if (!STATE_ENABLED) return { ok: true, persisted: false, state_store: 'disabled' };
  const id = requestId(body.request_id);
  const trace = traceId(body.trace_id);
  const scope = keyPart(body.scope, 'default');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query('SELECT state FROM platform.requests WHERE request_id = $1 FOR UPDATE', [id])).rows[0];
    if (existing) {
      await client.query('COMMIT');
      return { ok: true, persisted: false, duplicate: true, request_id: id, trace_id: trace, state: existing.state };
    }
    await client.query(
      `INSERT INTO platform.requests
        (request_id, trace_id, scope, session_id, idempotency_key, state, attempt)
       VALUES ($1,$2,$3,$4,$5,'RUNNING',$6)`,
      [id, trace, scope, String(body.session_id || '').slice(0, 200), body.idempotency_key ? String(body.idempotency_key).slice(0, 200) : null, Math.max(0, Number(body.attempt || 0))],
    );
    const events = [
      [null, 'RECEIVED'],
      ['RECEIVED', 'VALIDATED'],
      ['VALIDATED', 'RUNNING'],
    ];
    for (const [fromState, toState] of events) {
      await client.query(
        `INSERT INTO platform.events (request_id, trace_id, event_type, from_state, to_state, payload)
         VALUES ($1,$2,'state.transition',$3,$4,$5)`,
        [id, trace, fromState, toState, body.payload || null],
      );
    }
    await client.query('COMMIT');
    bump('state_transitions_total');
    return { ok: true, persisted: true, request_id: id, trace_id: trace, state: 'RUNNING' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    bump('state_store_errors_total');
    throw error;
  } finally {
    client.release();
  }
}

async function recordToolRun(body) {
  if (!STATE_ENABLED) return { ok: true, persisted: false, state_store: 'disabled' };
  const id = requestId(body.request_id);
  const trace = traceId(body.trace_id);
  const state = String(body.state || '').toUpperCase();
  if (!['PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REPLAYED', 'UNKNOWN'].includes(state)) return { ok: false, error: 'invalid_tool_state' };
  const result = await db.query(
    `INSERT INTO platform.tool_runs
      (request_id, trace_id, tool_name, tool_call_id, state, attempt, idempotency_key, input, output, error_code, error_message, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING tool_run_id`,
    [id, trace, String(body.tool_name || 'unknown').slice(0, 160), body.tool_call_id || null, state, Math.max(0, Number(body.attempt || 0)), body.idempotency_key || null,
      body.input || null, body.output || body.result || null, body.error_code || null, body.error_message || null,
      body.started_at || null, body.finished_at || (['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(state) ? new Date().toISOString() : null)],
  );
  return { ok: true, persisted: true, tool_run_id: result.rows[0]?.tool_run_id || null, request_id: id, trace_id: trace };
}

async function admission(body) {
  const scope = keyPart(body.scope, 'default');
  const idemKey = String(body.idempotency_key || '').trim();
  if (!idemKey) return { ok: true, admitted: true, idempotency: 'disabled' };
  const key = `platform:idem:${scope}:${keyPart(idemKey)}`;
  const record = JSON.stringify({ status: 'PROCESSING', request_id: body.request_id || '', trace_id: body.trace_id || '', started_at: new Date().toISOString() });
  const claimed = await redis.set(key, record, { NX: true, EX: IDEM_TTL });
  if (claimed === 'OK') {
    bump('idempotency_admitted_total');
    return { ok: true, admitted: true, replayed: false, state: 'PROCESSING', key: key.slice(0, 80) };
  }
  const existingRaw = await redis.get(key);
  let existing = null;
  try { existing = existingRaw ? JSON.parse(existingRaw) : null; } catch { existing = null; }
  if (existing?.status === 'SUCCEEDED') {
    bump('idempotency_replayed_total');
    return { ok: true, admitted: false, replayed: true, state: 'SUCCEEDED', result: existing.result ?? null, key: key.slice(0, 80) };
  }
  if (existing?.status === 'UNKNOWN') {
    bump('idempotency_unknown_total');
    if (existing.result != null) {
      bump('idempotency_replayed_total');
      return { ok: true, admitted: false, replayed: true, unknown: true, state: 'UNKNOWN', result: existing.result, key: key.slice(0, 80) };
    }
    return { ok: true, admitted: false, unknown: true, state: 'UNKNOWN', result: existing.result ?? null, error_code: existing.error_code || 'side_effect_unknown', key: key.slice(0, 80) };
  }
  return { ok: true, admitted: false, in_flight: true, state: existing?.status || 'PROCESSING', key: key.slice(0, 80) };
}

async function complete(body) {
  const scope = keyPart(body.scope, 'default');
  const idemKey = String(body.idempotency_key || '').trim();
  if (!idemKey) return { ok: true, persisted: false };
  const key = `platform:idem:${scope}:${keyPart(idemKey)}`;
  const current = await redis.get(key);
  if (!current) return { ok: false, error: 'idempotency_record_missing' };
  let parsed = {};
  try { parsed = JSON.parse(current); } catch { parsed = {}; }
  const owner = String(body.request_id || '').trim();
  if (parsed.request_id && owner !== parsed.request_id) {
    return { ok: false, error: 'idempotency_owner_mismatch' };
  }
  const next = {
    ...parsed,
    status: 'SUCCEEDED',
    result: body.result ?? null,
    completed_at: new Date().toISOString(),
  };
  await redis.set(key, JSON.stringify(next), { EX: Math.max(1, Number(body.ttl_sec || IDEM_TTL)) });
  return { ok: true, persisted: true };
}

async function markUnknown(body) {
  const scope = keyPart(body.scope, 'default');
  const idemKey = String(body.idempotency_key || '').trim();
  if (!idemKey) return { ok: true, persisted: false };
  const key = `platform:idem:${scope}:${keyPart(idemKey)}`;
  const current = await redis.get(key);
  if (!current) return { ok: false, error: 'idempotency_record_missing' };
  let parsed = {};
  try { parsed = JSON.parse(current); } catch { parsed = {}; }
  const owner = String(body.request_id || '').trim();
  if (parsed.request_id && owner !== parsed.request_id) {
    return { ok: false, error: 'idempotency_owner_mismatch' };
  }
  if (parsed.status === 'SUCCEEDED') return { ok: true, persisted: false, state: 'SUCCEEDED' };
  const next = {
    ...parsed,
    status: 'UNKNOWN',
    error_code: String(body.error_code || 'side_effect_unknown').slice(0, 120),
    error_message: String(body.error_message || '').slice(0, 500),
    result: body.result ?? parsed.result ?? null,
    unknown_at: new Date().toISOString(),
  };
  await redis.set(key, JSON.stringify(next), { EX: Math.max(1, Number(body.ttl_sec || IDEM_TTL)) });
  return { ok: true, persisted: true, state: 'UNKNOWN' };
}

const jobKey = (jobId) => `platform:job:${keyPart(jobId, 'unknown')}`;

async function enqueueJob(body) {
  const jobId = String(body.job_id || '').trim();
  const jobType = String(body.job_type || '').trim();
  if (!jobId || !jobType || !body.payload) return { ok: false, error: 'job_id, job_type and payload are required' };
  if (jobType !== 'kb_save') return { ok: false, error: 'unsupported_job_type' };
  const key = jobKey(jobId);
  const existing = await redis.hGetAll(key);
  if (existing.job_id) return { ok: true, accepted: false, duplicate: true, job_id: jobId, status: existing.status || 'QUEUED' };
  const createdAt = new Date().toISOString();
  await redis.hSet(key, {
    job_id: jobId,
    job_type: jobType,
    status: 'QUEUED',
    attempts: '0',
    request_id: String(body.request_id || ''),
    trace_id: traceId(body.trace_id),
    scope: keyPart(body.scope, 'default'),
    idempotency_key: String(body.idempotency_key || ''),
    payload: JSON.stringify(body.payload),
    created_at: createdAt,
    updated_at: createdAt,
  });
  await redis.expire(key, JOB_TTL);
  await redis.xAdd(JOB_STREAM, '*', {
    job_id: jobId,
    job_type: jobType,
    request_id: String(body.request_id || ''),
    trace_id: traceId(body.trace_id),
    scope: keyPart(body.scope, 'default'),
    idempotency_key: String(body.idempotency_key || ''),
    payload: JSON.stringify(body.payload),
  });
  bump('jobs_enqueued_total');
  return { ok: true, accepted: true, job_id: jobId, status: 'QUEUED', created_at: createdAt };
}

async function getJob(jobId) {
  const row = await redis.hGetAll(jobKey(jobId));
  if (!row.job_id) return { ok: false, error: 'job_not_found' };
  const result = { ...row };
  delete result.payload;
  try { if (row.result) result.result = JSON.parse(row.result); } catch { /* keep raw result */ }
  return { ok: true, job: result };
}

async function completeJob(body) {
  const jobId = String(body.job_id || '').trim();
  const key = jobKey(jobId);
  const job = await redis.hGetAll(key);
  if (!job.job_id) return { ok: false, error: 'job_not_found' };
  const status = String(body.status || '').toUpperCase();
  if (!['SUCCEEDED', 'FAILED'].includes(status)) return { ok: false, error: 'invalid_job_status' };
  const result = body.result || {};
  const now = new Date().toISOString();
  await redis.hSet(key, { status, result: JSON.stringify(result), error_code: String(body.error_code || ''), error_message: String(body.error_message || ''), updated_at: now, finished_at: now });
  await redis.expire(key, JOB_TTL);
  const idemPayload = { scope: job.scope, idempotency_key: job.idempotency_key, request_id: job.request_id, result };
  await complete(idemPayload);
  const state = status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
  await recordToolRun({ request_id: job.request_id, trace_id: job.trace_id, tool_name: job.job_type, state, idempotency_key: job.idempotency_key, output: result, error_code: body.error_code, error_message: body.error_message, finished_at: now });
  await transitionRequest({ request_id: job.request_id, trace_id: job.trace_id, scope: job.scope, idempotency_key: job.idempotency_key, to_state: state, result, error_code: body.error_code, error_message: body.error_message });
  bump(status === 'SUCCEEDED' ? 'jobs_completed_total' : 'jobs_failed_total');
  return { ok: true, job_id: jobId, status, finished_at: now };
}

async function beginJobAttempt(body) {
  const jobId = String(body.job_id || '').trim();
  const key = jobKey(jobId);
  const job = await redis.hGetAll(key);
  if (!job.job_id) return { ok: false, error: 'job_not_found' };
  if (['SUCCEEDED', 'FAILED'].includes(String(job.status || '').toUpperCase())) {
    return { ok: true, job_id: jobId, terminal: true, status: job.status };
  }
  const attempts = Number(await redis.hIncrBy(key, 'attempts', 1));
  const now = new Date().toISOString();
  await redis.hSet(key, { status: 'RUNNING', updated_at: now, last_attempt_at: now });
  if (attempts > 1) bump('jobs_retried_total');
  return { ok: true, job_id: jobId, terminal: false, status: 'RUNNING', attempts };
}

async function retryJob(body) {
  const jobId = String(body.job_id || '').trim();
  const key = jobKey(jobId);
  const job = await redis.hGetAll(key);
  if (!job.job_id) return { ok: false, error: 'job_not_found' };
  if (['SUCCEEDED', 'FAILED'].includes(String(job.status || '').toUpperCase())) {
    return { ok: true, job_id: jobId, terminal: true, status: job.status };
  }
  const now = new Date().toISOString();
  await redis.hSet(key, {
    status: 'RETRY_WAITING',
    error_code: String(body.error_code || 'job_retryable_failure').slice(0, 120),
    error_message: String(body.error_message || '').slice(0, 500),
    updated_at: now,
    last_retry_at: now,
  });
  return { ok: true, job_id: jobId, status: 'RETRY_WAITING' };
}

async function rateLimit(body) {
  const scope = keyPart(body.scope, 'default');
  const limit = Math.max(1, Number(body.limit || DEFAULT_RPM));
  const windowSec = Math.max(1, Number(body.window_sec || 60));
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `platform:rate:${scope}:${bucket}`;
  const count = Number(await redis.eval(RATE_LIMIT, { keys: [key], arguments: [String(limit), String(windowSec + 1)] }));
  const allowed = count <= limit;
  if (!allowed) bump('rate_limited_total');
  return { ok: true, allowed, limit, count, remaining: Math.max(0, limit - count), reset_at: (bucket + 1) * windowSec * 1000 };
}

async function lockAcquire(body) {
  const resource = keyPart(body.resource, 'unknown');
  const token = String(body.token || crypto.randomUUID());
  const ttl = Math.max(1000, Number(body.ttl_ms || 30000));
  const key = `platform:lock:${resource}`;
  const acquired = await redis.set(key, token, { NX: true, PX: ttl });
  if (acquired === 'OK') bump('locks_acquired_total');
  else bump('locks_contended_total');
  return { ok: true, acquired: acquired === 'OK', resource, token: acquired === 'OK' ? token : undefined, ttl_ms: ttl };
}

async function lockRelease(body) {
  const resource = keyPart(body.resource, 'unknown');
  const token = String(body.token || '');
  if (!token) return { ok: false, error: 'token_required' };
  const released = Number(await redis.eval(LOCK_RELEASE, { keys: [`platform:lock:${resource}`], arguments: [token] }));
  return { ok: true, released: released === 1, resource };
}

async function route(req, res, path, body) {
  if (path === '/healthz' && req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'platform-runtime', redis: redis.isReady, state_store: STATE_ENABLED, idempotency_ttl_sec: IDEM_TTL });
  }
  if (path === '/readyz' && req.method === 'GET') {
    return json(res, redis.isReady ? 200 : 503, { ok: redis.isReady, service: 'platform-runtime', redis: redis.isReady });
  }
  if (path === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(metricText());
  }
  if (req.method === 'GET' && path.startsWith('/v1/jobs/')) {
    if (!authOk(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (!redis.isReady) return json(res, 503, { ok: false, error: 'redis_unavailable' });
    return json(res, 200, await getJob(path.slice('/v1/jobs/'.length)));
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  if (!authOk(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!redis.isReady) return json(res, 503, { ok: false, error: 'redis_unavailable' });
  if (path === '/v1/idempotency/admit') return json(res, 200, await admission(body));
  if (path === '/v1/idempotency/complete') return json(res, 200, await complete(body));
  if (path === '/v1/idempotency/unknown') return json(res, 200, await markUnknown(body));
  if (path === '/v1/jobs/enqueue') return json(res, 200, await enqueueJob(body));
  if (path === '/v1/jobs/attempt') {
    try { return json(res, 200, await beginJobAttempt(body)); }
    catch (error) { bump('state_store_errors_total'); return json(res, 503, { ok: false, error: 'job_attempt_failed' }); }
  }
  if (path === '/v1/jobs/retry') {
    try { return json(res, 200, await retryJob(body)); }
    catch (error) { bump('state_store_errors_total'); return json(res, 503, { ok: false, error: 'job_retry_failed' }); }
  }
  if (path === '/v1/jobs/complete') {
    try { return json(res, 200, await completeJob(body)); }
    catch (error) { bump('state_store_errors_total'); return json(res, 503, { ok: false, error: 'job_completion_failed' }); }
  }
  if (path === '/v1/rate-limit') return json(res, 200, await rateLimit(body));
  if (path === '/v1/locks/acquire') return json(res, 200, await lockAcquire(body));
  if (path === '/v1/locks/release') return json(res, 200, await lockRelease(body));
  if (path === '/v1/requests/transition') {
    try { return json(res, 200, await transitionRequest(body)); }
    catch (error) { return json(res, 503, { ok: false, error: 'state_store_unavailable' }); }
  }
  if (path === '/v1/requests/start') {
    try { return json(res, 200, await startRequest(body)); }
    catch (error) { return json(res, 503, { ok: false, error: 'state_store_unavailable' }); }
  }
  if (path === '/v1/tool-runs') {
    try { return json(res, 200, await recordToolRun(body)); }
    catch (error) { bump('state_store_errors_total'); return json(res, 503, { ok: false, error: 'state_store_unavailable' }); }
  }
  return json(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const path = String(req.url || '').split('?')[0];
    const startedAt = Date.now();
    res.once('finish', () => {
      observeRequest(Date.now() - startedAt);
      bump('http_requests_total');
      if (res.statusCode >= 500) bump('http_errors_total');
      if (!['/healthz', '/readyz', '/metrics'].includes(path)) {
        console.log(JSON.stringify({ event: 'runtime.request', path, method: req.method, status: res.statusCode, duration_ms: Date.now() - startedAt, trace_id: req.headers['x-trace-id'] || '', request_id: req.headers['x-request-id'] || '' }));
      }
    });
    const body = path === '/healthz' ? {} : await readBody(req);
    await route(req, res, path, body);
  } catch (error) {
    console.error('[runtime] request failed', error.message);
    json(res, error.message === 'invalid JSON' ? 400 : 500, { ok: false, error: error.message });
  }
});

await redis.connect();
server.listen(PORT, () => console.log(`[runtime] listening on ${PORT}`));

const shutdown = async () => {
  server.close();
  if (redis.isOpen) await redis.quit();
  await db.end().catch(() => {});
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
