#!/usr/bin/env node
/**
 * Evaluation case contract (Phase E1).
 *
 * Structural checks that do not need a live stack:
 *   1. every suite file parses; cases have id/category/kind/expect
 *   2. ids are unique across all suites; ids match the suite prefix
 *   3. every case names at least one assertion the harness can check
 *      (status / tools / args / answer / judge) — decorative cases are how
 *      "all green" stopped meaning anything in 2026-09
 *   4. origin is declared: ported / real-failure / boundary / canary
 *   5. real-failure cases carry a non-empty `why` (the triage contract)
 *   6. tool references must be real server tools or wf_* — parsed from the
 *      gateway workflow, the same single source of truth agent-eval uses
 *   7. no "evaluation fixture" wording in prompts (eval awareness guard)
 *
 * Usage:
 *   node n8n/scripts/eval-validate.mjs
 * Exit: 0 clean, 1 problems found, 2 setup error.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUITES_DIR = path.join(ROOT, 'eval', 'suites');
const GATEWAY = path.join(ROOT, 'workflows', 'chat-gateway.json');

const problems = [];
const warnings = [];
let checked = 0;

const serverToolNames = (() => {
  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(GATEWAY, 'utf8'));
  } catch (error) {
    console.error(`FATAL: cannot read ${GATEWAY}: ${error.message}`);
    process.exit(2);
  }
  const node = (workflow.nodes || []).find((item) => item.name === 'Build Upstream Payload');
  const code = String(node?.parameters?.jsCode || '');
  const start = code.indexOf('const TOOLS = [');
  const end = code.indexOf('const DIRECTIVE');
  if (!node || start < 0 || end <= start) {
    console.error('FATAL: cannot locate the TOOLS array in chat-gateway "Build Upstream Payload"');
    process.exit(2);
  }
  return new Set([...code.slice(start, end).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]));
})();

const isKnownTool = (name) => serverToolNames.has(String(name)) || String(name).startsWith('wf_');

const EVAL_AWARE_RE = /evaluation fixture|you are being (?:evaluated|tested)|this is a test/i;

let suiteFiles = [];
try {
  suiteFiles = fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith('.json'));
} catch (error) {
  console.error(`FATAL: cannot read ${SUITES_DIR}: ${error.message}`);
  process.exit(2);
}
if (!suiteFiles.length) {
  console.log('no suite files yet — nothing to validate (skeleton phase)');
  process.exit(0);
}

const seenIds = new Map();
const ORIGINS = new Set(['ported', 'real-failure', 'boundary', 'canary']);

for (const file of suiteFiles) {
  const full = path.join(SUITES_DIR, file);
  checked++;
  let suite;
  try {
    suite = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    problems.push(`${file}: invalid JSON (${error.message})`);
    continue;
  }
  const suiteName = suite.suite || file.replace(/\.json$/, '');
  const cases = suite.cases || [];
  if (!Array.isArray(cases) || !cases.length) problems.push(`${file}: no cases`);
  for (const c of cases) {
    const id = String(c.id || '');
    if (!id) { problems.push(`${file}: case without id`); continue; }
    if (seenIds.has(id)) problems.push(`${file}: duplicate case id "${id}" (also in ${seenIds.get(id)})`);
    seenIds.set(id, file);

    if (!c.category) problems.push(`${id}: missing category`);
    if (!['chat', 'sandbox', 'mcp'].includes(String(c.kind || ''))) problems.push(`${id}: kind must be chat|sandbox|mcp`);
    if (!c.expect || typeof c.expect !== 'object') { problems.push(`${id}: missing expect`); continue; }

    const e = c.expect;
    const hasAssertion
      = e.status !== undefined
      || e.tools !== undefined
      || e.args !== undefined
      || e.answer !== undefined
      || e.judge !== undefined
      || e.trace_forbidden_tools?.length
      || e.trace_required_tools?.length;
    if (!hasAssertion) problems.push(`${id}: no checkable assertion (decorative case)`);

    if (!ORIGINS.has(String(c.origin || ''))) problems.push(`${id}: origin must be one of ${[...ORIGINS].join('|')}`);
    if (c.origin === 'real-failure' && !String(c.why || '').trim()) {
      problems.push(`${id}: real-failure case without why (triage contract)`);
    }
    if (c.origin === 'ported' && !String(c.ported_from || '').trim()) {
      problems.push(`${id}: ported case without ported_from (dataset:id)`);
    }

    const tools = [
      ...(e.tools?.required || []),
      ...(e.tools?.forbidden || []),
      ...(e.args || []).map((a) => a.tool),
      ...(e.trace_forbidden_tools || []),
      ...(e.trace_required_tools || []),
    ];
    for (const t of tools) {
      if (!isKnownTool(t)) problems.push(`${id}: references unknown tool "${t}"`);
    }

    const promptText = [c.system, ...(c.turns || []).map((t) => (t.role === 'system' ? t.content : ''))].filter(Boolean).join(' ');
    if (EVAL_AWARE_RE.test(promptText)) {
      problems.push(`${id}: eval-aware prompt wording (tells the model it is being tested)`);
    }
  }
}

for (const p of problems) console.error(`  FAIL  ${p}`);
for (const w of warnings) console.error(`  WARN  ${w}`);
console.log(`checked ${checked} suite file(s), ${seenIds.size} case(s)`);
if (problems.length) {
  console.error(`validation FAILED: ${problems.length} problem(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log('validation OK');
