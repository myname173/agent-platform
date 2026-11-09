#!/usr/bin/env node
/**
 * Evaluation foundation (Phase E1).
 *
 * Mining candidate eval cases from chat_executions is deliberately cheap:
 * this script reads rows, scores them with transparent heuristics, and prints
 * a triage sheet — it never writes cases by itself. A candidate becomes a
 * case only after a human answers "what actually failed here" (the `why`
 * field), which keeps the frozen suite from encoding a wrong failure theory.
 *
 * Signals (documented in monitoring + agent-eval-framework):
 *   - status=error            → the platform itself admitted failure
 *   - tool errors in trace    → tool called, result not ok
 *   - blocked=true in trace   → a tool was refused (policy/permission)
 *   - re-ask within 5 min     → same session, similar text, user came back
 * tool_rounds=2 is NOT failure evidence by itself: the gateway drops the
 * tool list at the cap, so "2 rounds" mostly means "used the budget".
 *
 * Usage:
 *   node --env-file=.env n8n/scripts/eval-mine.mjs [--days 14] [--limit 200]
 *        [--out n8n/eval/candidates/]
 */

import fs from 'node:fs';
import path from 'node:path';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const KEY = process.env.N8N_API_KEY || '';
if (!KEY) {
  console.error('N8N_API_KEY missing (use --env-file=.env)');
  process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const days = Math.max(1, Number(arg('--days', 14)));
const limit = Math.min(250, Math.max(10, Number(arg('--limit', 200))));
const outDir = path.resolve(arg('--out', path.join(import.meta.dirname, '..', 'eval', 'candidates')));

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const H = { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' };

/* Two data-table API traps, both documented on this instance:
   - sortBy only works with the colon percent-encoded;
   - createdAt filters are silently ignored, so rows come back oldest-first.
   Sort desc here and cut the window client-side. */
const tableId = async (name) => {
  const list = await (await fetch(`${N8N}/api/v1/data-tables?limit=100`, { headers: H })).json();
  return (list.data || []).find((t) => t.name === name)?.id || null;
};

const rows = async (table, filterObj, rowLimit = 250) => {
  const id = await tableId(table);
  if (!id) return [];
  const qs = `limit=${rowLimit}&sortBy=${encodeURIComponent('createdAt:desc')}`
    + (filterObj ? `&filter=${encodeURIComponent(JSON.stringify(filterObj))}` : '');
  const r = await (await fetch(`${N8N}/api/v1/data-tables/${id}/rows?${qs}`, { headers: H })).json();
  return (r.data || []).filter((e) => String(e.createdAt || '') >= since);
};

const parseTrace = (raw) => {
  try { return JSON.parse(String(raw || '[]')); } catch { return []; }
};

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/* Re-ask: an assistant answer followed, within 5 minutes, by another user
   message in the same session whose normalized text shares a 6-char shingle. */
const looksReAsk = (msgs, idx, windowMs = 5 * 60_000) => {
  const cur = msgs[idx];
  if (!cur || cur.role !== 'user') return false;
  for (let j = idx - 1; j >= 0; j--) {
    const prev = msgs[j];
    if (prev.role !== 'user') continue;
    if ((new Date(cur.createdAt) - new Date(prev.createdAt)) > windowMs) break;
    const a = norm(prev.content); const b = norm(cur.content);
    if (a.length >= 6 && b.includes(a.slice(0, 6))) return true;
    return false;
  }
  return false;
};

const main = async () => {
  const execRows = await rows('chat_executions', null, limit);
  const msgRows = await rows('chat_messages', null, 250);
  const bySession = new Map();
  for (const m of msgRows) {
    const sid = String(m.session_id || '');
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(m);
  }
  for (const list of bySession.values()) list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const candidates = [];
  for (const row of execRows) {
    const trace = parseTrace(row.tool_trace);
    const toolErrors = trace.filter((t) => t && t.ok === false);
    const blocked = trace.filter((t) => t && t.blocked === true);
    const sessionMsgs = bySession.get(String(row.session_id || '')) || [];
    const lastUser = [...sessionMsgs].reverse().find((m) => m.role === 'user');
    const reAsk = sessionMsgs.some((m, i) => looksReAsk(sessionMsgs, i));
    const signals = {
      status_error: String(row.status || '') === 'error',
      tool_error: toolErrors.length > 0,
      tool_blocked: blocked.length > 0,
      re_ask: reAsk,
      rounds_at_cap: Number(row.tool_rounds || 0) >= Number(process.env.MAX_TOOL_ROUNDS || 2),
    };
    const score
      = (signals.status_error ? 3 : 0)
      + (signals.tool_error ? 2 : 0)
      + (signals.tool_blocked ? 1 : 0)
      + (signals.re_ask ? 2 : 0)
      + (signals.rounds_at_cap ? 1 : 0);
    if (score === 0) continue;
    candidates.push({
      candidate_id: `cand_${String(row.execution_id || row.id || candidates.length).slice(-12)}`,
      session_id: row.session_id || '',
      trace_id: row.trace_id || '',
      created_at: row.createdAt || row.created_at || '',
      model: row.model || '',
      client: row.client || '',
      status: row.status || '',
      error_code: row.error_code || '',
      error_message: String(row.error_message || '').slice(0, 300),
      latency_ms: row.latency_ms ?? null,
      tool_rounds: row.tool_rounds ?? null,
      signals,
      score,
      tool_trace_summary: trace.map((t) => ({
        tool: t?.tool || '', blocked: t?.blocked === true, ok: t?.ok !== false,
      })).slice(0, 10),
      last_user_text: String(lastUser?.content || '').slice(0, 500),
      // The human triage fields. A candidate with an empty `why` must not be
      // promoted into the frozen suite — that is the whole point of this file.
      triage: { decision: '', why: '', mapped_tools: '', expected_assertions: '' },
    });
  }

  candidates.sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `candidates-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    window_days: days,
    scanned_executions: execRows.length,
    scanned_messages: msgRows.length,
    candidates: candidates.length,
    note: 'candidates only — human triage required before promotion (fill triage.why)',
    rows: candidates,
  }, null, 2) + '\n');

  console.log(`scanned ${execRows.length} executions / ${msgRows.length} messages in ${days}d`);
  console.log(`candidates: ${candidates.length} -> ${outFile}`);
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${c.score} ${c.candidate_id} status=${c.status} tools=${c.tool_trace_summary.map((t) => t.tool).join(',') || '-'} reAsk=${c.signals.re_ask}`);
  }
  if (!candidates.length) console.log('no candidates — keep mining nightly; boundary cases do not need this file');
};

await main();
