#!/usr/bin/env node
/**
 * Phase 2 async kb_save regression.
 *
 * Requires PLATFORM_KB_ASYNC_ENABLED=true in n8n and the phase2 worker to be
 * running. It verifies the 202 queue response, eventual KB visibility, and a
 * same-key replay without invoking the chat model.
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/test-kb-async.mjs
 */
import assert from 'node:assert/strict';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required (use --env-file=.env)');
  process.exit(2);
}

const runId = String(Date.now());
const title = 'phase2-async-kb-save-' + runId;
const text = 'phase2 async kb_save regression ' + runId + '. This temporary note verifies queueing, worker completion and replay.';
const idempotencyKey = 'phase2-async-kb-' + runId;
const traceId = '0123456789abcdef0123456789abcdef';
const requestId = 'phase2-async-request-' + runId;

const post = async (body, extra = {}) => {
  const response = await fetch(N8N + '/webhook/admin/kb/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + CHAT_KEY,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
  return { status: response.status, body: parsed };
};

const headers = (request) => ({
  'x-idempotency-key': idempotencyKey,
  'x-trace-id': traceId,
  'x-request-id': request,
  'x-session-id': 'phase2-async-session-' + runId,
});

const waitForDocument = async () => {
  const deadline = Date.now() + Number(process.env.ASYNC_TEST_TIMEOUT_MS || 90000);
  while (Date.now() < deadline) {
    const listed = await post({ mode: 'list' });
    if (listed.status === 200) {
      const doc = (listed.body.docs || []).find((item) => item.title === title && item.status === 'active');
      if (doc) return doc;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('timed out waiting for async kb_save document');
};

let docId = '';
try {
  const queued = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    headers(requestId),
  );
  assert.equal(queued.status, 202, 'async kb_save must return 202');
  assert.equal(queued.body.status, 'queued', 'async kb_save must report queued');
  assert.ok(queued.body.task_id, 'async kb_save must return task_id');
  assert.equal(queued.body.trace_id, traceId, 'trace_id must be preserved');

  const doc = await waitForDocument();
  docId = String(doc.id || doc.doc_id || '');
  assert.ok(docId, 'async kb_save must create a document');

  const replay = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    headers(requestId + '-replay'),
  );
  assert.equal(replay.status, 200, 'async kb_save replay');
  assert.equal(replay.body.__platform_replay, true, 'replay must come from runtime');
  assert.equal(String(replay.body.doc_id || ''), docId, 'replay document id');

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    boundary: 'kb_save.async',
    task_id: queued.body.task_id,
    doc_id: docId,
    replay: true,
    trace_id: traceId,
  }, null, 2));
} finally {
  const cleanup = await post({ mode: 'retire', doc_id: docId || title });
  if (cleanup.status !== 200 || cleanup.body?.ok !== true) {
    console.error('cleanup failed:', JSON.stringify(cleanup));
    process.exitCode = 1;
  }
}
