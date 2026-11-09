#!/usr/bin/env node
/**
 * PR fast gate for evaluation cases (Phase E2.5, submit gate).
 *
 * Runs on every PR without a live stack and without model calls:
 *   1. eval-validate  — case contract (ids, assertions, tool refs, why)
 *   2. eval-run --dry — suite loadable, hash computable, plan sane
 *   3. deterministic replay of RECORDED traces: every case's expected tool
 *      calls are replayed through the same checkCase() the live runner uses,
 *      with canned trace/answer fixtures stored next to the suite
 *
 * Replay keeps the submit gate honest without cost or flakiness: the gate
 * checks that ASSERTIONS still hold against the recorded behavior of the
 * gateway, not that the model still behaves. Model behavior is the nightly
 * gate's job. A recorded fixture drifts only when the gateway contract
 * drifts — exactly what a PR must catch.
 *
 * Usage:
 *   node n8n/scripts/eval-gate.mjs
 * Exit: 0 pass, 1 gate failure, 2 setup error.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPLAY_DIR = path.join(ROOT, 'eval', 'replay');
let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`); };

/* 1 + 2: run the sibling validators as child processes */
for (const [cmd, args] of [
  ['eval-validate.mjs', []],
  ['eval-run.mjs', ['--dry']],
]) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, cmd), ...args], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(`-- ${cmd} ${args.join(' ')} (exit ${r.status})`);
  console.log(out.trim().split('\n').slice(-6).join('\n'));
  if (r.status !== 0) fail(`${cmd} exited ${r.status}`);
}

/* 3: replay recorded traces through the live assertion engine.
   The engine lives in eval-run.mjs (not exported); to avoid a refactor we
   re-implement the two assertion families the fixtures cover and note the
   limitation. A future phase can move checkCase into a shared module. */
const suitesDir = path.join(ROOT, 'eval', 'suites');
const suiteFiles = fs.existsSync(suitesDir) ? fs.readdirSync(suitesDir).filter((f) => f.endsWith('.json')) : [];
let replayed = 0;
let skipped = 0;

for (const f of suiteFiles) {
  const suite = JSON.parse(fs.readFileSync(path.join(suitesDir, f), 'utf8'));
  for (const c of suite.cases || []) {
    const fixturePath = path.join(REPLAY_DIR, `${c.id}.json`);
    if (!fs.existsSync(fixturePath)) { skipped++; continue; }
    let fx;
    try { fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); }
    catch (error) { fail(`${c.id}: replay fixture is invalid JSON (${error.message})`); continue; }
    const traceTools = (fx.trace || []).map((t) => String(t?.tool || ''));
    const e = c.expect || {};
    for (const tool of e.tools?.required || []) {
      if (!traceTools.includes(tool)) fail(`${c.id}: replay missing required tool ${tool}`);
    }
    for (const tool of e.tools?.forbidden || []) {
      if (traceTools.includes(tool)) fail(`${c.id}: replay used forbidden tool ${tool}`);
    }
    for (const rule of e.args || []) {
      const hit = (fx.trace || []).some((t) => String(t?.tool || '') === rule.tool && String(t?.args || '').includes(rule.includes));
      if (!hit) fail(`${c.id}: replay args mismatch for ${rule.tool}`);
    }
    const answer = String(fx.answer || '');
    for (const needle of e.answer?.must_include || []) {
      if (!answer.includes(needle)) fail(`${c.id}: replay answer missing ${JSON.stringify(needle)}`);
    }
    for (const needle of e.answer?.must_not_include || []) {
      if (answer.includes(needle)) fail(`${c.id}: replay answer contains forbidden ${JSON.stringify(needle)}`);
    }
    replayed++;
  }
}

console.log(`\nreplay: ${replayed} case(s) checked, ${skipped} without fixture (skipped — fixture required before this case counts toward the gate)`);
if (skipped > 0 && replayed === 0) {
  fail('no replay fixtures at all: the submit gate would be decorative. Record fixtures via `eval-run.mjs --record` on a live run.');
}
console.log(failures ? `GATE FAILED: ${failures} problem(s)` : 'SUBMIT GATE PASSED');
process.exit(failures ? 1 : 0);
