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
    // priority 3: multi-key attribution + per-turn cost
    { name: 'key_name', type: 'string' },
    { name: 'cost_usd', type: 'number' },
  ],
  chat_executions: [
    { name: 'execution_id', type: 'string' },
    { name: 'session_id', type: 'string' },
    { name: 'model', type: 'string' },
    { name: 'client', type: 'string' },
    // priority 3: multi-key attribution + per-request cost
    { name: 'key_name', type: 'string' },
    { name: 'cost_usd', type: 'number' },
    { name: 'error_raw', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'error_code', type: 'string' },
    { name: 'error_message', type: 'string' },
    { name: 'latency_ms', type: 'number' },
    { name: 'prompt_tokens', type: 'number' },
    { name: 'completion_tokens', type: 'number' },
    { name: 'total_tokens', type: 'number' },
  ],
  // priority 3: managed gateway keys (hash-only storage, per-key limits & spend)
  // embedding quota meter (single row; total_embed_tokens)
  // phase 2: console audit trail
  admin_audit: [
    { name: 'action', type: 'string' },
    { name: 'target', type: 'string' },
    { name: 'detail', type: 'string' }
  ],

  kb_usage: [
    { name: 'total_embed_tokens', type: 'number' },
  ],

  // proactive briefs: daily digest rows (Schedule Daily 8:30 + manual run)
  daily_briefs: [
    { name: 'title', type: 'string' },
    { name: 'content_md', type: 'string' },
    { name: 'brief_date', type: 'string' },
    { name: 'meta', type: 'string' }
  ],

  // selfcheck: platform self-test runs
  selfcheck_runs: [
    { name: 'source', type: 'string' },
    { name: 'total', type: 'number' },
    { name: 'passed', type: 'number' },
    { name: 'failed', type: 'number' },
    { name: 'warned', type: 'number' },
    { name: 'duration_ms', type: 'number' },
    { name: 'checked_at', type: 'string' },
    { name: 'report', type: 'string' },
  ],

  // heartbeats: scheduled-job liveness (e.g. backup)
  heartbeats: [
    { name: 'job', type: 'string' },
    { name: 'ok', type: 'number' },
    { name: 'detail', type: 'string' },
  ],

  // telegram bridge: polling offset state
  telegram_state: [
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
  ],

  // wishlist #3: reminders created from chat (delivered via the notify channel)
  reminders: [
    { name: 'text', type: 'string' },
    { name: 'due_at', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'delivered', type: 'string' },
    { name: 'created_via', type: 'string' },
    { name: 'attempts', type: 'number' },
    { name: 'meta', type: 'string' },
  ],

  // priority 6: error-rate alerting (data table, API-accessible)
  ops_alerts: [
    { name: 'kind', type: 'string' },
    { name: 'window_minutes', type: 'number' },
    { name: 'total', type: 'number' },
    { name: 'errors', type: 'number' },
    { name: 'error_rate', type: 'number' },
    { name: 'threshold', type: 'number' },
    { name: 'message', type: 'string' },
    // phase 2: alert webhook delivery status
    { name: 'delivered', type: 'string' },
  ],
  gateway_keys: [
    { name: 'key_hash', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'enabled', type: 'number' },
    { name: 'rate_limit_rpm', type: 'number' },
    { name: 'total_cost', type: 'number' },
    // phase 2 finale: per-key budget hard limits (rolling 24h / 30d; 0 = unlimited)
    { name: 'budget_daily_usd', type: 'number' },
    { name: 'budget_monthly_usd', type: 'number' },
    { name: 'spend_24h', type: 'number' },
    { name: 'spend_24h_at', type: 'string' },
    { name: 'spend_30d', type: 'number' },
    { name: 'spend_30d_at', type: 'string' },
  ],
};

async function ensureColumns(tableId, expected) {
  const existing = new Set((await api('GET', `/data-tables/${tableId}/columns`)).map((c) => c.name));
  for (const col of expected || []) {
    if (existing.has(col.name)) continue;
    try {
      await api('POST', `/data-tables/${tableId}/columns`, { name: col.name, type: col.type });
      console.log(`  added column ${col.name} (${col.type})`);
    } catch (e) {
      if (String(e).includes('409')) continue; // concurrent create
      throw e;
    }
  }
}

async function resolveDataTableId(name) {
  const list = await api('GET', `/data-tables?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
  if (list.data?.length) {
    const id = list.data[0].id;
    await ensureColumns(id, DATA_TABLE_COLUMNS[name]);
    return id;
  }
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
    // (also covers recreation on a fresh instance, where the old id no
    //  longer exists and the source must follow the new one)
    if (String(created.id) !== String(raw.id)) {
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
// ensure all declared data tables exist (some are only referenced from Code
// node strings, which the @name scan inside deploy() cannot see)
for (const name of Object.keys(DATA_TABLE_COLUMNS)) {
  await resolveDataTableId(name);
}

for (const f of files) {
  try {
    await deploy(f);
  } catch (e) {
    console.error(`FAILED ${f}: ${e.message}`);
    process.exitCode = 1;
  }
}
