#!/usr/bin/env node
/**
 * Complete recorded-fixture replay, using the live deterministic assertion engine.
 * node n8n/scripts/eval-gate.mjs --replay-dir .eval-local/replay/<run-id> --runs 3
 * Default directory contains only manually reviewed, sanitized fixtures.
 * Missing/stale/partial fixtures fail closed. This does NOT execute current gateway
 * code or prove live model behavior, calibrated answer quality, or final DB state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHash, loadSuites, loadTools, positiveInteger, replayFixture } from './eval-contract.mjs';

export function replayAll({ cases, suiteHash, hash, dir, runs }) {
  const errors = []; let replayed = 0;
  for (const c of cases) {
    const file = path.join(dir, `${c.id}.json`);
    if (!fs.existsSync(file)) { errors.push(`${c.id}: missing fixture`); continue; }
    try {
      const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
      errors.push(...replayFixture(fx, c, suiteHash, hash, runs).map((e) => `${c.id}: ${e}`));
      replayed++;
    } catch (e) { errors.push(`${c.id}: invalid fixture (${e.message})`); }
  }
  return { replayed, required: cases.length, errors };
}
export function main(argv = process.argv.slice(2)) {
  const root = path.resolve(import.meta.dirname, '..');
  let dir = path.join(root, 'eval', 'replay'); let runs = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replay-dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) dir = path.resolve(argv[++i]);
    else if (argv[i] === '--runs' && argv[i + 1]) runs = positiveInteger(argv[++i], 'runs');
    else throw new Error(`unknown/incomplete option: ${argv[i]}`);
  }
  const tools = loadTools(path.join(root, 'workflows', 'chat-gateway.json'));
  const { cases, suiteHash } = loadSuites(path.join(root, 'eval', 'suites'), tools);
  const result = replayAll({ cases, suiteHash, hash: harnessHash(import.meta.dirname), dir, runs });
  for (const e of result.errors) console.error(`FAIL ${e}`);
  console.log(`replay coverage: ${result.replayed}/${result.required}; attempts required per case=${runs}`);
  console.log(result.errors.length ? 'GATE FAILED' : 'DETERMINISTIC REPLAY PASSED (not release acceptance)');
  return result.errors.length ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (e) { console.error(`GATE SETUP FAILED: ${e.message}`); process.exitCode = 2; }
}
