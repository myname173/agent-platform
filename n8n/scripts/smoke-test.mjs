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
 *   - Managed keys & rate limiting (needs N8N_API_KEY; skipped when absent):
 *     unknown key 401, temp-key roundtrip, per-key 429, disabled key 401
 *   - Cost accounting: stats cost aggregates + per-row key_name/cost_usd
 *
 * Exit code 0 = all pass; 1 = at least one failure.
 */

import { createHash, randomBytes } from 'node:crypto';

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

const N8N_API_KEY = process.env.N8N_API_KEY || null;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const filterEq = (col, value) => JSON.stringify({ type: 'and', filters: [{ columnName: col, condition: 'eq', value }] });
const n8nApi = async (method, path, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

group('gateway: managed keys & rate limit');
{
  if (!N8N_API_KEY) {
    console.log('  SKIP  N8N_API_KEY not set — managed-key & rate-limit checks skipped');
  } else {
    // unknown managed key -> 401
    let r = await req('POST', '/webhook/v1/chat/completions', {
      key: 'sk-gw-does-not-exist-' + Date.now(),
      body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'hi' }] }
    });
    check(r.status === 401 && isOpenAIError(r.json), 'unknown managed key -> 401 + envelope', `${r.status}`);

    // create a temp key (rpm=1) for live checks
    const keyRaw = 'sk-gw-' + randomBytes(24).toString('hex');
    const keyHash = sha256(keyRaw);
    const tables = await n8nApi('GET', '/data-tables?limit=100');
    const gt = (tables.data || []).find((t) => t.name === 'gateway_keys');
    if (!gt) {
      fail('gateway_keys table exists', 'run n8n/scripts/deploy.mjs');
    } else {
      const ins = await n8nApi('POST', `/data-tables/${gt.id}/rows`, { data: [{ key_hash: keyHash, name: '_smoke_tmp_' + Date.now(), enabled: 1, rate_limit_rpm: 1, total_cost: 0 }] });
      check(ins?.success === true || Array.isArray(ins), 'temp managed key inserted (rpm=1)', JSON.stringify(ins).slice(0, 100));

      // valid managed key -> 200 (real LLM call)
      r = await req('POST', '/webhook/v1/chat/completions', {
        key: keyRaw,
        body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'Reply with OK only.' }] }
      });
      check(r.status === 200, 'valid managed key -> 200', `${r.status} ${r.text?.slice(0, 120)}`);

      // wait for the exec row + spend bookkeeping to land before the 429 test
      let total = 0;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const rows = await n8nApi('GET', `/data-tables/${gt.id}/rows?filter=${encodeURIComponent(filterEq('key_hash', keyHash))}`);
        total = Number((rows.data || [])[0]?.total_cost) || 0;
        if (total > 0) break;
      }
      check(total > 0, 'gateway_keys.total_cost accumulated after request', `total_cost=${total}`);

      // second request within the rolling window -> 429
      r = await req('POST', '/webhook/v1/chat/completions', {
        key: keyRaw,
        body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'hi' }] }
      });
      check(r.status === 429 && isOpenAIError(r.json) && r.json?.error?.code === 'rate_limit_exceeded', 'second request within window -> 429 rate_limit_exceeded', `${r.status} ${r.text?.slice(0, 120)}`);

      // disabled key -> 401
      await n8nApi('PATCH', `/data-tables/${gt.id}/rows/update`, { filter: { type: 'and', filters: [{ columnName: 'key_hash', condition: 'eq', value: keyHash }] }, data: { enabled: 0 } });
      r = await req('POST', '/webhook/v1/chat/completions', {
        key: keyRaw,
        body: { model: 'deepseek-agent', messages: [{ role: 'user', content: 'hi' }] }
      });
      check(r.status === 401 && isOpenAIError(r.json), 'disabled key -> 401 + envelope', `${r.status}`);

      // cleanup temp key row (filter goes in the query string)
      const del = await n8nApi('DELETE', `/data-tables/${gt.id}/rows/delete?filter=${encodeURIComponent(filterEq('key_hash', keyHash))}`);
      check(del === true || Array.isArray(del), 'temp key cleaned up', JSON.stringify(del).slice(0, 80));
    }
  }
}

group('cost accounting (stats)');
{
  // poll briefly so the just-finished requests have been logged
  let j = null;
  for (let i = 0; i < 12; i++) {
    const r = await req('GET', '/webhook/v1/stats/executions', { key: 'valid' });
    j = r.json;
    if (typeof j?.cost?.total_cost_usd === 'number' && j.cost.total_cost_usd > 0) break;
    await sleep(1000);
  }
  check(j?.cost && typeof j.cost.total_cost_usd === 'number', 'stats.cost.total_cost_usd present', JSON.stringify(j?.cost?.total_cost_usd));
  check(typeof j?.cost?.cost_24h_usd === 'number' && typeof j?.cost?.cost_7d_usd === 'number', 'cost_24h/7d present');
  check(j?.cost?.by_model && typeof j.cost.by_model === 'object', 'cost.by_model present');
  check(j?.cost?.by_key && typeof j.cost.by_key === 'object', 'cost.by_key present');
  check((j?.cost?.total_cost_usd ?? 0) > 0, 'total_cost_usd > 0 (real spend recorded)', String(j?.cost?.total_cost_usd));
  const row = Array.isArray(j?.recent) ? j.recent.find((x) => x.cost_usd > 0) : null;
  check(row && 'key_name' in row, 'recent rows carry key_name & nonzero cost_usd', JSON.stringify(j?.recent?.[0]).slice(0, 140));
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
