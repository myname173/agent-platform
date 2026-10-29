#!/usr/bin/env node
/**
 * Phase 1.3 kb_save boundary regression.
 *
 * Exercises the chat/MCP source_type path without invoking the chat model:
 * first save, same-key runtime replay, and cleanup via the existing retire
 * mode. The test document is removed even when an assertion fails after the
 * first write.
 *
 * Usage: node --env-file=.env n8n/scripts/test-kb-boundary.mjs
 */
import assert from 'node:assert/strict';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required (use --env-file=.env)');
  process.exit(2);
}

const runId = String(Date.now());
const title = 'phase1.3-kb-save-boundary-' + runId;
const text = 'phase1.3 kb_save boundary test ' + runId + '。 This temporary note verifies runtime idempotency and trace propagation.';
const idempotencyKey = 'phase1.3-kb-save-' + runId;
const traceId = 'abcdefabcdefabcdefabcdefabcdefab';
const requestId = 'phase1.3-kb-save-request-' + runId;
let docId = '';

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

try {
  const body = { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey };
  const first = await post(body, {
    'x-idempotency-key': idempotencyKey,
    'x-trace-id': traceId,
    'x-request-id': requestId,
    'x-session-id': 'phase1.3-kb-session-' + runId,
  });
  assert.equal(first.status, 200, 'kb_save first call');
  assert.equal(first.body.ok, true, 'kb_save first call must succeed');
  assert.ok(first.body.doc_id, 'kb_save must return a document id');
  docId = String(first.body.doc_id);

  const replay = await post(body, {
    'x-idempotency-key': idempotencyKey,
    'x-trace-id': traceId,
    'x-request-id': requestId + '-replay',
    'x-session-id': 'phase1.3-kb-session-' + runId,
  });
  assert.equal(replay.status, 200, 'kb_save replay');
  assert.equal(replay.body.__platform_replay, true, 'kb_save replay must come from runtime');
  assert.equal(replay.body.doc_id, docId, 'kb_save replay document id');

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    boundary: 'kb_save',
    first_doc_id: docId,
    replay: true,
    trace_id: replay.body.trace_id,
  }, null, 2));
} finally {
  const cleanup = await post({ mode: 'retire', doc_id: docId || title });
  if (cleanup.status !== 200 || cleanup.body?.ok !== true) {
    console.error('cleanup failed:', JSON.stringify(cleanup));
    process.exitCode = 1;
  }
}
