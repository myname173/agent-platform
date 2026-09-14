#!/usr/bin/env node
/**
 * Manage Chat Gateway API keys (Data Table `gateway_keys`).
 *
 * Keys are stored as SHA-256 hashes — the raw key is only shown once at
 * creation. The primary key remains $env.CHAT_API_KEY (LobeChat's key);
 * managed keys add per-client identity, per-key rate limits (rpm) and
 * spend tracking.
 *
 * Usage (N8N_API_KEY from env or .env):
 *   node n8n/scripts/keys.mjs list
 *   node n8n/scripts/keys.mjs add <name> [rpm]      # prints the raw key ONCE
 *   node n8n/scripts/keys.mjs enable <name>
 *   node n8n/scripts/keys.mjs disable <name>
 *   node n8n/scripts/keys.mjs set-limit <name> <rpm>
 *   node n8n/scripts/keys.mjs rm <name>
 *
 * <rpm> = allowed requests per minute (0 = unlimited).
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const N8N_URL = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
let N8N_API_KEY = process.env.N8N_API_KEY;
if (!N8N_API_KEY) {
  // convenience: load from the repo-root .env when present
  try {
    const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), 'utf8');
    N8N_API_KEY = env.match(/^N8N_API_KEY=(.*)$/m)?.[1].trim();
  } catch { /* ignore */ }
}
if (!N8N_API_KEY) {
  console.error('N8N_API_KEY is required (env var or .env)');
  process.exit(2);
}

const api = async (method, path, qs, body) => {
  const res = await fetch(`${N8N_URL}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

const tableId = async () => {
  const list = await api('GET', '/data-tables', { limit: 100 });
  const t = (list.data || []).find((x) => x.name === 'gateway_keys');
  if (!t) throw new Error('gateway_keys table not found — run n8n/scripts/deploy.mjs first');
  return t.id;
};
const filter = (col, value) => JSON.stringify({ type: 'and', filters: [{ columnName: col, condition: 'eq', value }] });
const filterObj = (col, value) => ({ type: 'and', filters: [{ columnName: col, condition: 'eq', value }] });
const findByName = async (id, name) => {
  const rows = await api('GET', `/data-tables/${id}/rows`, { filter: filter('name', name) });
  return (rows.data || [])[0] || null;
};
const round = (x) => Math.round(x * 1e6) / 1e6;

const [cmd, ...args] = process.argv.slice(2);
const usage = () => {
  console.error('usage: keys.mjs list | add <name> [rpm] | enable|disable|rm <name> | set-limit <name> <rpm>');
  process.exit(2);
};

if (cmd === 'list') {
  const id = await tableId();
  const rows = await api('GET', `/data-tables/${id}/rows`, { limit: 200, sortBy: 'createdAt:asc' });
  const keys = rows.data || [];
  if (!keys.length) { console.log('no managed keys'); process.exit(0); }
  const now = Date.now();
  console.log('name            rpm   enabled  total_cost_usd  created_at');
  for (const k of keys) {
    const age = now - (Date.parse(k.createdAt) || 0);
    const ageStr = age > 86_400_000 ? `${Math.floor(age / 86_400_000)}d ago` : age > 3_600_000 ? `${Math.floor(age / 3_600_000)}h ago` : `${Math.max(1, Math.floor(age / 60_000))}m ago`;
    console.log(
      String(k.name || 'unnamed').padEnd(15),
      String(k.rate_limit_rpm ?? 0).padEnd(5),
      String(k.enabled === 1 || k.enabled === true ? 'yes' : 'NO').padEnd(8),
      String(round(Number(k.total_cost) || 0)).padEnd(15),
      ageStr
    );
  }
} else if (cmd === 'add') {
  const name = args[0];
  if (!name) usage();
  const rpm = Number(args[1] || 0);
  if (!Number.isFinite(rpm) || rpm < 0) { console.error('rpm must be a non-negative number'); process.exit(2); }
  const id = await tableId();
  if (await findByName(id, name)) { console.error(`key "${name}" already exists`); process.exit(1); }
  const raw = `sk-gw-${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(raw).digest('hex');
  await api('POST', `/data-tables/${id}/rows`, null, { data: [{ key_hash: keyHash, name, enabled: 1, rate_limit_rpm: rpm, total_cost: 0 }] });
  console.log(`key created: ${name} (rpm=${rpm === 0 ? 'unlimited' : rpm})`);
  console.log('');
  console.log(`  ${raw}`);
  console.log('');
  console.log('Store it now — the raw key is NOT persisted and cannot be shown again.');
} else if (cmd === 'enable' || cmd === 'disable') {
  const name = args[0];
  if (!name) usage();
  const id = await tableId();
  const row = await findByName(id, name);
  if (!row) { console.error(`key "${name}" not found`); process.exit(1); }
  await api('PATCH', `/data-tables/${id}/rows/update`, null, { filter: filterObj('name', name), data: { enabled: cmd === 'enable' ? 1 : 0 } });
  console.log(`${cmd}d key "${name}"`);
} else if (cmd === 'set-limit') {
  const name = args[0];
  const rpm = Number(args[1]);
  if (!name || !Number.isFinite(rpm) || rpm < 0) usage();
  const id = await tableId();
  if (!(await findByName(id, name))) { console.error(`key "${name}" not found`); process.exit(1); }
  await api('PATCH', `/data-tables/${id}/rows/update`, null, { filter: filterObj('name', name), data: { rate_limit_rpm: rpm } });
  console.log(`key "${name}" rpm -> ${rpm === 0 ? 'unlimited' : rpm}`);
} else if (cmd === 'rm') {
  const name = args[0];
  if (!name) usage();
  const id = await tableId();
  const deleted = await api('DELETE', `/data-tables/${id}/rows/delete?filter=${encodeURIComponent(filter('name', name))}&returnData=true`);
  const n = Array.isArray(deleted) ? deleted.length : 0;
  console.log(`removed ${n} key row(s) named "${name}"`);
} else {
  usage();
}
