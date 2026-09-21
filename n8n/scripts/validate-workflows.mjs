#!/usr/bin/env node
/**
 * Structural validation for deployable n8n workflow sources + compose env hygiene.
 * No network, no dependencies — safe to run in CI.
 *
 * Checks:
 *  1. every n8n/workflows/*.json parses and has required fields
 *  2. connections only reference existing node names
 *  3. webhook paths are unique across workflows
 *  4. no hardcoded secrets in workflow code or docker-compose.yml
 *  5. every ${VAR} used by docker-compose.yml exists in .env.example
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wfDir = join(root, 'n8n', 'workflows');
const errors = [];
const warnings = [];
let checked = 0;

/* ---------- 1-3: workflow files ---------- */
const files = readdirSync(wfDir).filter((f) => f.endsWith('.json'));
if (files.length === 0) errors.push('no workflow files found in n8n/workflows/');

const KNOWN_NODE_PREFIXES = ['n8n-nodes-base.', '@n8n/n8n-nodes-langchain.'];
const webhookPaths = new Map(); // path -> file

for (const file of files) {
  const path = join(wfDir, file);
  checked++;
  let wf;
  try {
    wf = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`${file}: invalid JSON (${e.message})`);
    continue;
  }

  for (const field of ['name', 'nodes', 'connections', 'settings']) {
    if (wf[field] === undefined) errors.push(`${file}: missing required field "${field}"`);
  }
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) {
    errors.push(`${file}: "nodes" must be a non-empty array`);
    continue;
  }

  const names = new Set(wf.nodes.map((n) => n.name));
  if (names.size !== wf.nodes.length) errors.push(`${file}: duplicate node names`);

  for (const node of wf.nodes) {
    if (!node.name || !node.type) errors.push(`${file}: node missing name/type`);
    if (!KNOWN_NODE_PREFIXES.some((p) => node.type?.startsWith(p))) {
      errors.push(`${file}: unknown node type "${node.type}"`);
    }
    if (!Array.isArray(node.position) || node.position.length !== 2) {
      warnings.push(`${file}: node "${node.name}" has no valid position (canvas rendering)`);
    }
    // secret scan inside node parameters
    const blob = JSON.stringify(node.parameters ?? {});
    if (/(eyJhbGciOi|(?<![\w-])sk-[A-Za-z0-9_-]{6,}(?![\w-]))/.test(blob)) {
      errors.push(`${file}: node "${node.name}" appears to contain a hardcoded key (sk-…/JWT)`);
    }
    if (node.type === 'n8n-nodes-base.webhook') {
      const p = node.parameters?.path;
      if (!p) errors.push(`${file}: webhook node "${node.name}" has no path`);
      else if (webhookPaths.has(p)) errors.push(`${file}: webhook path "${p}" duplicates ${webhookPaths.get(p)}`);
      else webhookPaths.set(p, file);
      if (node.parameters?.responseMode !== 'responseNode') {
        warnings.push(`${file}: webhook "${node.name}" is not in responseNode mode`);
      }
    }
  }

  for (const [from, conn] of Object.entries(wf.connections ?? {})) {
    if (!names.has(from)) errors.push(`${file}: connections source "${from}" is not a node`);
    for (const branches of Object.values(conn)) {
      for (const branch of branches) {
        for (const target of branch) {
          if (!names.has(target.node)) errors.push(`${file}: connection "${from}" -> "${target.node}" references missing node`);
        }
      }
    }
  }
}

/* ---------- 4-5: compose hygiene ---------- */
const composePath = join(root, 'docker-compose.yml');
if (existsSync(composePath)) {
  const compose = readFileSync(composePath, 'utf8');
  const literalKey = compose.match(/=\s*(sk-[A-Za-z0-9_-]{6,})/);
  if (literalKey) errors.push(`docker-compose.yml contains a literal API key (${literalKey[1].slice(0, 6)}…) — move it to .env`);
  if (/eyJhbGciOi/.test(compose)) errors.push('docker-compose.yml contains a literal JWT — move it to .env');

  const usedVars = [...compose.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  const envExamplePath = join(root, '.env.example');
  if (!existsSync(envExamplePath)) {
    errors.push('.env.example missing but docker-compose.yml uses ${VAR} interpolation');
  } else {
    const example = readFileSync(envExamplePath, 'utf8');
    for (const v of new Set(usedVars)) {
      if (!new RegExp(`^${v}=`, 'm').test(example)) {
        errors.push(`.env.example is missing variable ${v} (used by docker-compose.yml)`);
      }
    }
  }
}

/* ---------- report ---------- */
console.log(`validated ${checked} workflow file(s)`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.error(`  FAIL  ${e}`);
if (errors.length) {
  console.error(`validation FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`validation passed (${warnings.length} warning(s))`);
