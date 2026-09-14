#!/usr/bin/env node
/**
 * Contract smoke tests for the agent-platform n8n layer.
 * Run AFTER deploy against a live instance:
 *
 *   N8N_URL=http://localhost:5678 CHAT_API_KEY=sk-… node n8n/scripts/smoke-test.mjs
 *
 * Covers:
 *   - health endpoint
 *   - Chat Gateway /webhook/v1/chat/completions: auth (401), request
 *     validation (400), model routing (404), happy path (200 + OpenAI
 *     response shape + real usage), error envelope shape everywhere
 *   - Chat Stats API /webhook/v1/stats/executions: auth + payload shape
 *   - Chat Retention /webhook/admin/retention/run: auth + summary shape
 *     (note: an authorized call actually runs retention — by design it
 *     only deletes rows past the configured cutoffs)
 *
 * Exit code 0 = all pass; 1 = at least one failure.
 */

const BASE = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const KEY = process.env.CHAT_API_KEY;

if (!KEY) {
  console.error('CHAT_API_KEY is required (the gateway Bearer key)');
  process.exit(2);
}

/* ---------------- tiny assertion harness ---------------- */
const results = [];
let current = '';

const group = (name) => {
  current = name;
  console.log(`\n== ${name}`);
};
const pass = (msg) => {
  results.push(true);
  console.log(`  PASS  ${msg}`);
};
const fail = (msg, detail) => {
  results.push(false);
  console.error(`  FAIL  ${msg}${detail ? `\n        ${detail}` : ''}`);
};
const check = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

async function req(method, path, { key, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key === 'valid') headers.Authorization = `Bearer ${KEY}`;
  else if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text: raw ? text : undefined };
}

const isOpenAIError = (j) =>
  j && typeof j === 'object' && j.error && typeof j.error.message === 'string' &&
  typeof j.error.type === 'string' && typeof j.error.code === 'string';

/* ---------------- tests ---------------- */

group('health');
{
  const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10_000) });
  const j = await res.json().catch(() => null);
  check(res.status === 200, 'GET /healthz -> 200', `got ${res.status}`);
  check(j?.status === 'ok', 'health status is "ok"', JSON.stringify(j));
}

group('gateway: auth');
{
  let r = await req('POST', '/webhook/v1/chat/completions', {
    body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'hi' }] }
  });
  check(r.status === 401, 'missing key -> 401', `got ${r.status}`);
  check(isOpenAIError(r.json), '401 body is OpenAI error envelope', r.text?.slice(0, 120));

  r = await req('POST', '/webhook/v1/chat/completions', {
    key: 'sk-definitely-wrong',
    body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'hi' }] }
  });
  check(r.status === 401 && isOpenAIError(r.json), 'wrong key -> 401 + envelope');
}

group('gateway: request validation');
{
  let r = await req('POST', '/webhook/v1/chat/completions', {
    key: 'valid',
    body: { model: 'deepseek-agent', messages: [] }
  });
  check(r.status === 400 && r.json?.error?.code === 'missing_messages', 'empty messages -> 400 missing_messages', JSON.stringify(r.json));

  r = await req('POST', '/webhook/v1/chat/completions', {
    key: 'valid',
    body: { model: 'deepseek-agent', messages: [{ role: 'system', content: 'only system' }] }
  });
  check(r.status === 400 && r.json?.error?.code === 'missing_user_message', 'no user message -> 400', JSON.stringify(r.json));

  r = await req('POST', '/webhook/v1/chat/completions', {
    key: 'valid',
    body: { model: 'gpt-99', messages: [{ role: 'user', content: 'hi' }] }
  });
  check(r.status === 404 && r.json?.error?.code === 'model_not_found', 'unknown model -> 404 model_not_found', JSON.stringify(r.json));
}

group('gateway: happy path (hits DeepSeek)');
{
  const started = Date.now();
  const r = await req('POST', '/webhook/v1/chat/completions', {
    key: 'valid',
    body: {
      model: 'deepseek-agent',
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a test fixture. Always reply with the single word OK.' },
        { role: 'user', content: 'ping' }
      ]
    }
  });
  const ms = Date.now() - started;
  if (r.status === 502) {
    fail(
      'valid request -> 200',
      `got 502 (upstream DeepSeek unreachable?). Envelope shape itself: ${isOpenAIError(r.json) ? 'ok' : 'BROKEN'}`
    );
  } else {
    check(r.status === 200, 'valid request -> 200', `got ${r.status} ${r.text?.slice(0, 120)}`);
    const j = r.json;
    check(typeof j?.id === 'string' && j.id.startsWith('chatcmpl-'), 'response.id present (chatcmpl-…)', j?.id);
    check(j?.object === 'chat.completion', 'response.object is chat.completion', j?.object);
    check(typeof j?.created === 'number', 'response.created is epoch seconds');
    check(j?.model === 'deepseek-agent', 'response.model echoes requested alias', j?.model);
    check(
      Array.isArray(j?.choices) && j.choices[0]?.message?.role === 'assistant' &&
        typeof j.choices[0]?.message?.content === 'string' && j.choices[0].message.content.length > 0,
      'choices[0].message is a non-empty assistant message'
    );
    check(j?.choices?.[0]?.finish_reason === 'stop', 'finish_reason is stop', j?.choices?.[0]?.finish_reason);
    check(
      typeof j?.usage?.total_tokens === 'number' && j.usage.total_tokens > 0,
      'usage carries real token counts',
      JSON.stringify(j?.usage)
    );
    check(ms < 60_000, `latency sane (${ms}ms)`);
  }
}

group('chat stats API');
{
  let r = await req('GET', '/webhook/v1/stats/executions');
  check(r.status === 401 && isOpenAIError(r.json), 'no key -> 401 + envelope');

  r = await req('GET', '/webhook/v1/stats/executions', { key: 'valid' });
  check(r.status === 200, 'with key -> 200', `got ${r.status} ${r.text?.slice(0, 120)}`);
  const j = r.json;
  check(
    j?.totals && typeof j.totals.total === 'number' && typeof j.totals.success === 'number' &&
      typeof j.totals.error === 'number' && typeof j.totals.error_rate === 'number',
    'totals block complete',
    JSON.stringify(j?.totals)
  );
  check(typeof j?.avg_latency_ms === 'number', 'avg_latency_ms present');
  check(j?.by_model && typeof j.by_model === 'object', 'by_model present');
  check(typeof j?.unique_sessions === 'number', 'unique_sessions present');
  check(Array.isArray(j?.recent), 'recent is an array');
  if (Array.isArray(j?.recent) && j.recent.length > 0) {
    const row = j.recent[0];
    check(
      row.execution_id && row.status && row.created_at && 'latency_ms' in row,
      'recent rows carry execution_id/status/latency/created_at',
      JSON.stringify(row).slice(0, 120)
    );
  }
}

group('chat retention (manual trigger — runs retention for real)');
{
  let r = await req('POST', '/webhook/admin/retention/run');
  check(r.status === 401 && isOpenAIError(r.json), 'no key -> 401 + envelope');

  r = await req('POST', '/webhook/admin/retention/run', { key: 'valid' });
  check(r.status === 200, 'with key -> 200', `got ${r.status} ${r.text?.slice(0, 120)}`);
  const j = r.json;
  check(
    Array.isArray(j?.retention) && j.retention.length === 2 &&
      j.retention.every((x) => x.table && ('deleted' in x || 'error' in x)),
    'retention summary lists both tables',
    JSON.stringify(j?.retention)
  );
  check(j?.retention?.every((x) => !x.error), 'no retention errors', JSON.stringify(j?.retention));
}

/* ---------------- summary ---------------- */
const total = results.length;
const failed = results.filter((x) => !x).length;
console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) {
  console.error(`SMOKE TEST FAILED (${failed} failure(s))`);
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
