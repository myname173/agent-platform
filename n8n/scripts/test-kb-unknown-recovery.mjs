#!/usr/bin/env node
/**
 * Validate kb_save UNKNOWN handling and operator recovery.
 *
 * The first call has an empty body, so it fails before embedding or any KB
 * write. Runtime admission still claims the key and the adapter records
 * UNKNOWN. The script then verifies retry blocking, manually completes the
 * runtime record as a confirmed validation failure, and verifies that a
 * later retry only replays that failure.
 *
 * Usage (Docker CLI must be available):
 *   node --env-file=.env n8n/scripts/test-kb-unknown-recovery.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const DOCKER = process.env.DOCKER_BIN || 'docker';
if (!CHAT_KEY) {
  console.error('CHAT_API_KEY is required (use --env-file=.env)');
  process.exit(2);
}

const runId = String(Date.now());
const title = 'phase1.3-kb-unknown-recovery-' + runId;
const text = 'This text must not be written after UNKNOWN recovery ' + runId + '.';
const idempotencyKey = 'phase1.3-kb-unknown-' + runId;
const requestId = 'phase1.3-kb-unknown-request-' + runId;
const traceId = 'fedcbafedcbafedcbafedcbafedcbafe';

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

const headersFor = (request) => ({
  'x-idempotency-key': idempotencyKey,
  'x-trace-id': traceId,
  'x-request-id': request,
  'x-session-id': 'phase1.3-kb-unknown-session-' + runId,
});

const runtimeRecover = async () => {
  const payload = {
    scope: 'kb:save',
    idempotency_key: idempotencyKey,
    request_id: requestId,
    trace_id: traceId,
    result: { ok: false, status: 422, error: 'validation_failed', code: 'empty_text_confirmed', title },
  };
  const script = [
    "const payload = " + JSON.stringify(payload) + ";",
    "const key = process.env.PLATFORM_RUNTIME_KEY || process.env.CHAT_API_KEY || '';",
    "const h = { 'Content-Type': 'application/json', 'x-platform-runtime-key': key };",
    "const call = async (path, body) => { const r = await fetch('http://127.0.0.1:3220' + path, { method: 'POST', headers: h, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };",
    "const complete = await call('/v1/idempotency/complete', payload);",
    "const tool = await call('/v1/tool-runs', { request_id: payload.request_id, trace_id: payload.trace_id, tool_name: 'kb_save', state: 'FAILED', idempotency_key: payload.idempotency_key, input: { title: payload.result.title }, output: payload.result, error_code: payload.result.code, error_message: payload.result.error });",
    "const transition = await call('/v1/requests/transition', { request_id: payload.request_id, trace_id: payload.trace_id, scope: payload.scope, idempotency_key: payload.idempotency_key, to_state: 'FAILED', result: payload.result, error_code: payload.result.code, error_message: payload.result.error });",
    "console.log(JSON.stringify({ complete, tool, transition }));",
  ].join('');
  const { stdout } = await execFileAsync(DOCKER, ['exec', 'platform-runtime', 'node', '-e', script], { maxBuffer: 1_000_000 });
  return JSON.parse(stdout.trim());
};

let cleanup = null;
try {
  const invalid = await post(
    { mode: 'ingest', title, text: '', source_type: 'chat', idempotency_key: idempotencyKey },
    headersFor(requestId),
  );
  assert.equal(invalid.status, 503, 'invalid kb_save must surface UNKNOWN as 503');
  assert.equal(invalid.body.error?.code, 'kb_save_unknown', 'invalid kb_save error code');

  const blocked = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    headersFor(requestId + '-blocked'),
  );
  assert.equal(blocked.status, 409, 'UNKNOWN retry must be blocked');
  assert.ok(['kb_save_failed', 'side_effect_unknown'].includes(blocked.body.error?.code), 'UNKNOWN retry error code');

  const recovered = await runtimeRecover();
  assert.equal(recovered.complete.status, 200, 'runtime completion');
  assert.equal(recovered.complete.body.persisted, true, 'runtime completion must persist');
  assert.equal(recovered.transition.status, 200, 'FAILED state transition');
  assert.equal(recovered.transition.body.state, 'FAILED', 'recovery must close the request as FAILED');

  const replay = await post(
    { mode: 'ingest', title, text, source_type: 'chat', idempotency_key: idempotencyKey },
    headersFor(requestId + '-replay'),
  );
  assert.equal(replay.status, 422, 'confirmed failed retry must preserve a non-2xx status');
  assert.equal(replay.body.__platform_replay, true, 'recovered retry must come from runtime');
  assert.equal(replay.body.ok, false, 'recovered result must remain a confirmed failure');
  assert.equal(replay.body.code, 'empty_text_confirmed', 'recovered failure code');

  const listed = await post({ mode: 'list' });
  assert.equal(listed.status, 200, 'KB list after recovery');
  assert.equal((listed.body.docs || []).some((doc) => doc.title === title && doc.status === 'active'), false, 'UNKNOWN test must not create an active document');

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    boundary: 'kb_save',
    unknown_status: invalid.status,
    blocked_status: blocked.status,
    recovered_state: recovered.transition.body.state,
    replay_status: replay.status,
    active_document_created: false,
  }, null, 2));
} finally {
  cleanup = await post({ mode: 'retire', title });
  if (cleanup.status !== 200 || cleanup.body?.ok !== true) {
    console.error('cleanup failed:', JSON.stringify(cleanup));
    process.exitCode = 1;
  }
}
