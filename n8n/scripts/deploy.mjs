#!/usr/bin/env node
/**
 * Deploy n8n workflows from JSON files in n8n/workflows/.
 *
 * Usage:
 *   N8N_URL=http://localhost:5678 N8N_API_KEY=<key> node n8n/scripts/deploy.mjs
 *
 * Behavior:
 *   - Deploys every *.json file directly under n8n/workflows/ (baseline/ ignored).
 *   - Workflow with an "id" field  -> PUT (update in place, keeps webhook registration path).
 *   - Workflow without an "id"     -> POST (create).
 *   - Files with "active": true are (de)activated so production webhooks re-register.
 *   - Data table ids referenced as "@table_name" in dataTableId.value are resolved
 *     (table created if missing) before the workflow is sent.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const N8N_URL = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY;
if (!N8N_API_KEY) {
  console.error('N8N_API_KEY is required');
  process.exit(1);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

const api = async (method, path, body) => {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

const DATA_TABLE_COLUMNS = {
  chat_messages: [
    { name: 'session_id', type: 'string' },
    { name: 'role', type: 'string' },
    { name: 'content', type: 'string' },
    { name: 'model', type: 'string' },
    { name: 'client', type: 'string' },
  ],
  chat_executions: [
    { name: 'execution_id', type: 'string' },
    { name: 'session_id', type: 'string' },
    { name: 'model', type: 'string' },
    { name: 'client', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'error_code', type: 'string' },
    { name: 'error_message', type: 'string' },
    { name: 'latency_ms', type: 'number' },
    { name: 'prompt_tokens', type: 'number' },
    { name: 'completion_tokens', type: 'number' },
    { name: 'total_tokens', type: 'number' },
  ],
};

async function resolveDataTableId(name) {
  const list = await api('GET', `/data-tables?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
  if (list.data?.length) return list.data[0].id;
  const created = await api('POST', '/data-tables', { name, columns: DATA_TABLE_COLUMNS[name] });
  console.log(`  created data table ${name} -> ${created.id}`);
  return created.id;
}

async function ensureDataTables(workflow) {
  const blob = JSON.stringify(workflow);
  const names = [...blob.matchAll(/"value":"@([\w-]+)"/g)].map((m) => m[1]);
  const ids = {};
  for (const name of new Set(names)) {
    ids[name] = await resolveDataTableId(name);
    console.log(`  data table ${name} -> ${ids[name]}`);
  }
  return JSON.parse(blob.replaceAll(/"value":"@([\w-]+)"/g, (_, n) => `"value":"${ids[n]}"`));
}

async function deploy(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const wf = await ensureDataTables(raw);
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings || {},
    staticData: wf.staticData ?? null,
  };
  let id = wf.id;
  let existed = false;
  if (id) {
    try {
      await api('GET', `/workflows/${id}`);
      existed = true;
    } catch {
      existed = false;
    }
  }
  if (existed) {
    await api('PUT', `/workflows/${id}`, payload);
    console.log(`updated  ${wf.name} (${id})`);
  } else {
    const created = await api('POST', '/workflows', payload);
    id = created.id;
    console.log(`created  ${wf.name} (${id})`);
    // persist the generated id back into the source file for future updates
    if (!wf.id) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, JSON.stringify({ ...raw, id }, null, 2) + '\n');
    }
  }
  if (wf.active) {
    await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
    await api('POST', `/workflows/${id}/activate`);
    console.log(`activated ${wf.name}`);
  }
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => join(dir, f));
if (!files.length) {
  console.log('no workflow files found');
  process.exit(0);
}
for (const f of files) {
  try {
    await deploy(f);
  } catch (e) {
    console.error(`FAILED ${f}: ${e.message}`);
    process.exitCode = 1;
  }
}
