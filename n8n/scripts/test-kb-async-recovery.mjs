#!/usr/bin/env node
/**
 * Phase 2.1 async worker recovery regression.
 *
 * Requires Docker Desktop. The script temporarily enables the async KB path,
 * assigns the queued stream message to a dead consumer, then starts the
 * worker with a short claim idle time so XAUTOCLAIM must recover it.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/test-kb-async-recovery.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const DOCKER = process.env.DOCKER_BIN || 'docker';
if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required (use --env-file=.env)');
  process.exit(2);
}

const runId = String(Date.now());
const title = 'phase2-async-recovery-' + runId;
const text = 'phase2.1 async recovery regression ' + runId + '. This temporary note verifies stale pending reclaim.';
const idempotencyKey = 'phase2-async-recovery-' + runId;
const traceId = 'abcdef0123456789abcdef0123456789';
const requestId = 'phase2-async-recovery-request-' + runId;
const composeEnv = { ...process.env, PLATFORM_KB_ASYNC_ENABLED: 'true', PLATFORM_JOB_CLAIM_IDLE_MS: '1000' };

const runDocker = async (args, env = composeEnv) => execFileAsync(DOCKER, args, { cwd: ROOT, env, maxBuffer: 2_000_000 });

const post = async (body, extra = {}) => {
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

const waitForN8n = async () => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(N8N + '/healthz');
      if (response.ok) {
        const route = await post({ mode: 'list' });
        if (route.status === 200) return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('n8n did not become healthy');
};

const waitForDocument = async () => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const listed = await post({ mode: 'list' });
    if (listed.status === 200) {
      const doc = (listed.body.docs || []).find((item) => item.title === title && item.status === 'active');
      if (doc) return doc;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('timed out waiting for XAUTOCLAIM-recovered document');
};

let docId = '';
try {
  await runDocker(['compose', '--profile', 'phase2', 'stop', 'platform-worker']);
  await runDocker(['compose', '--profile', 'phase2', 'up', '-d', '--force-recreate', 'n8n']);
  await waitForN8n();

  const queued = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    { 'x-idempotency-key': idempotencyKey, 'x-trace-id': traceId, 'x-request-id': requestId },
  );
  assert.equal(queued.status, 202, 'async kb_save must return 202');
  assert.ok(queued.body.task_id, 'async kb_save must return task_id');

  const deadConsumer = 'dead-' + runId;
  await runDocker(['exec', 'platform-redis', 'redis-cli', 'XREADGROUP', 'GROUP', 'platform-kb-workers', deadConsumer, 'COUNT', '1', 'STREAMS', 'platform:jobs', '>']);
  await runDocker(['compose', '--profile', 'phase2', 'up', '-d', 'platform-worker']);

  const doc = await waitForDocument();
  docId = String(doc.id || doc.doc_id || '');
  assert.ok(docId, 'recovered job must create a document');
  const pending = await runDocker(['exec', 'platform-redis', 'redis-cli', 'XPENDING', 'platform:jobs', 'platform-kb-workers']);
  assert.match(pending.stdout.trim(), /^0\s*$/m, 'recovered stream message must be ACKed');

  const replay = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    { 'x-idempotency-key': idempotencyKey, 'x-trace-id': traceId, 'x-request-id': requestId + '-replay' },
  );
  assert.equal(replay.status, 200, 'recovered job replay');
  assert.equal(replay.body.__platform_replay, true, 'recovered replay must come from runtime');
  assert.equal(String(replay.body.doc_id || ''), docId, 'recovered replay document id');

  console.log(JSON.stringify({ ok: true, run_id: runId, boundary: 'kb_save.async.recovery', task_id: queued.body.task_id, doc_id: docId, pending: 0 }, null, 2));
} finally {
  if (docId) await post({ mode: 'retire', doc_id: docId }).catch(() => {});
  await runDocker(['compose', '--profile', 'phase2', 'stop', 'platform-worker']).catch(() => {});
  await runDocker(['compose', 'up', '-d', '--force-recreate', 'n8n'], { ...process.env, PLATFORM_KB_ASYNC_ENABLED: 'false' }).catch(() => {});
}
