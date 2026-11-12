#!/usr/bin/env node

// Live acceptance for the sandbox gateway's request admission (P1).
// Operator-run against the loopback pilot bridge; NOT part of CI (needs
// Docker Desktop Kubernetes + the gateway Deployment + a port-forward).
//
// Usage (repo root):
//   node deploy/k8s/phase3-pilot/admission-check.mjs
//   node deploy/k8s/phase3-pilot/admission-check.mjs --url http://127.0.0.1:18080
//   node deploy/k8s/phase3-pilot/admission-check.mjs --allowlist chat-gateway,agent-eval,admission-check,admission-check-rate,admission-check-busy
//
// The key is read from CHAT_API_KEY (env) or the repo .env and is never
// printed. Default mode verifies accounting-mode admission (allowlist empty);
// --allowlist verifies enforcement: the listed names must include the three
// admission-check* callers, and unlisted/header-less callers must get 403.
//
// Probes spawn real short-lived Jobs (print / time.sleep). They self-clean via
// ttlSecondsAfterFinished; the concurrency probe holds 4 slots for a few
// seconds, so do not run this while a business burst is in flight.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf('--url', 'http://127.0.0.1:18080').replace(/\/$/, '');
const allowlistArg = argOf('--allowlist', '');
const ALLOWLIST_MODE = Boolean(allowlistArg);

const readKey = () => {
  if (process.env.CHAT_API_KEY) return process.env.CHAT_API_KEY;
  const envFile = join(here, '..', '..', '..', '.env');
  if (!existsSync(envFile)) return '';
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => /^CHAT_API_KEY=/.test(l));
  if (!line) return '';
  return line.slice('CHAT_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
};
const KEY = readKey();
if (!KEY) {
  console.error('CHAT_API_KEY not found in env or repo .env; cannot run live admission check');
  process.exit(2);
}

const call = async (path, { method = 'POST', headers = {}, body, timeoutMs = 60000 } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text };
};
const run = (code, caller, extra = {}) => call('/run', {
  headers: { 'x-sandbox-key': KEY, ...(caller ? { 'x-sandbox-caller': caller } : {}), ...extra },
  body: { code, timeout: 8, allow_network: false },
});

const probes = [];
const record = (name, ok, detail) => {
  probes.push({ name, ok, detail });
  if (!ok) console.error(`FAIL ${name}: ${detail}`);
};

// 1) healthz
try {
  const r = await call('/healthz', { method: 'GET', timeoutMs: 5000 });
  record('healthz', r.status === 200 && r.json?.ok === true, `status=${r.status}`);
} catch (e) { record('healthz', false, String(e.message || e)); }

// 2) missing key -> 401
{
  const r = await call('/run', { body: { code: 'print(1)' } });
  record('unauthorized_401', r.status === 401 && r.json?.error === 'unauthorized', `status=${r.status} error=${r.json?.error}`);
}

// 3) invalid caller identity -> 400 (checked before any Job)
{
  const r = await run('print(1)', 'Bad Caller');
  record('invalid_caller_400', r.status === 400 && r.json?.error === 'invalid_caller', `status=${r.status} error=${r.json?.error}`);
}

// 4) allowlist enforcement (only in --allowlist mode)
if (ALLOWLIST_MODE) {
  const unlisted = await run('print(1)', 'admission-check-unlisted');
  record('allowlist_unlisted_403', unlisted.status === 403 && unlisted.json?.error === 'caller_not_allowed', `status=${unlisted.status} error=${unlisted.json?.error}`);
  const headerless = await run('print(1)', '');
  record('allowlist_headerless_403', headerless.status === 403 && headerless.json?.error === 'caller_not_allowed', `status=${headerless.status} error=${headerless.json?.error}`);
}

// 5) happy path with a listed/known caller
{
  const r = await run('print(2 + 2)', 'admission-check');
  const ok = r.status === 200 && r.json?.ok === true && String(r.json?.stdout || '').trim() === '4';
  record('happy_path_job', ok, `status=${r.status} ok=${r.json?.ok} stdout=${JSON.stringify(r.json?.stdout)} blocked=${r.json?.blocked}`);
}

// 6) header-less default caller: admitted in accounting mode, 403 under allowlist
{
  const r = await run('print(1)', '');
  const ok = ALLOWLIST_MODE ? r.status === 403 : r.status === 200 && r.json?.ok === true;
  record('default_caller', ok, `status=${r.status} mode=${ALLOWLIST_MODE ? 'allowlist' : 'accounting'}`);
}

// 7) rate limit: 12 PARALLEL requests on a fresh caller (burst default 10).
//    Parallel on purpose: sequential awaits would let the bucket refill.
{
  const responses = await Promise.all(Array.from({ length: 12 }, () => run('print(1)', 'admission-check-rate')));
  const rateLimited = responses.filter((r) => r.status === 429 && r.json?.error === 'rate_limited');
  const admitted = responses.filter((r) => r.status === 200);
  const retryAfterOk = rateLimited.every((r) => Number(r.headers.get('retry-after')) >= 1);
  record('rate_limited_429', rateLimited.length >= 1 && admitted.length >= 1 && retryAfterOk,
    `rate_limited=${rateLimited.length} admitted=${admitted.length} busy=${responses.filter((r) => r.json?.error === 'busy').length} retry_after_ok=${retryAfterOk}`);
}

// 8) concurrency cap: 6 PARALLEL sleep jobs on a fresh caller (cap default 4).
{
  const responses = await Promise.all(Array.from({ length: 6 }, () => run('import time; time.sleep(4)', 'admission-check-busy')));
  const busy = responses.filter((r) => r.status === 429 && r.json?.error === 'busy');
  const admitted = responses.filter((r) => r.status === 200);
  record('busy_429', busy.length >= 1, `busy=${busy.length} admitted=${admitted.length} rate_limited=${responses.filter((r) => r.json?.error === 'rate_limited').length}`);
}

// 9) metrics surface: every rejection class must be visible as a counter.
{
  const r = await call('/metrics', { method: 'GET', timeoutMs: 5000 });
  const text = r.text;
  const counter = (decision) => {
    let sum = 0;
    for (const m of text.matchAll(new RegExp(`sandbox_gateway_requests_total\\{caller="[^"]*",decision="${decision}"\\} (\\d+)`, 'g'))) sum += Number(m[1]);
    return sum;
  };
  const required = ['unauthorized', 'invalid_caller', 'admitted', 'rate_limited', 'busy'];
  if (ALLOWLIST_MODE) required.push('caller_not_allowed');
  const counts = Object.fromEntries(required.map((d) => [d, counter(d)]));
  const ok = r.status === 200 && required.every((d) => counts[d] >= 1)
    && /sandbox_gateway_runs_total\{caller="admission-check",outcome="ok"\} [1-9]/.test(text)
    && /sandbox_gateway_job_duration_seconds_count [1-9]/.test(text)
    && /sandbox_gateway_inflight_jobs 0/.test(text);
  record('metrics_surface', ok, JSON.stringify(counts));
}

const ok = probes.every((p) => p.ok);
console.log(JSON.stringify({
  ok,
  mode: ALLOWLIST_MODE ? 'allowlist-enforcement' : 'accounting',
  url: BASE,
  probes,
}, null, 2));
process.exit(ok ? 0 : 1);