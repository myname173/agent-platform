#!/usr/bin/env node
/**
 * Read-only candidate miner. Signals nominate candidates, never prove failure;
 * a human must fill triage.why before promotion into an eval suite.
 *
 * Usage (credentials must already be in the environment; no .env file is read):
 *   node n8n/scripts/eval-mine.mjs --days 3 --limit 2000 [--timeout-ms 15000]
 *        [--out <local-directory>] [--dry]
 * --limit is a scan budget PER TABLE (including eval rows), not a page size.
 * Default output: <repository>/.eval-local/candidates (sensitive, never commit).
 * --dry validates arguments and prints a plan, without credentials, I/O or fetch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
const DEFAULT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.eval-local', 'candidates');
const TABLES = ['chat_executions', 'chat_messages'];

// Only these locally constructed codes, never upstream text/URLs, reach stderr.
export class MineError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new MineError('invalid_numeric_argument');
  }
  return Number(value);
}

export function parseArgs(argv) {
  const options = { days: 14, limit: 200, timeoutMs: 15000, outDir: DEFAULT_OUT, dry: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new MineError('duplicate_argument');
    seen.add(flag);
    if (flag === '--dry') { options.dry = true; continue; }
    if (!['--days', '--limit', '--timeout-ms', '--out'].includes(flag)) throw new MineError('unknown_argument');
    const value = argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new MineError('missing_argument');
    if (flag === '--days') options.days = positiveInteger(value, 36500);
    if (flag === '--limit') options.limit = positiveInteger(value);
    if (flag === '--timeout-ms') options.timeoutMs = positiveInteger(value, 2_147_483_647);
    if (flag === '--out') options.outDir = path.resolve(value);
  }
  return options;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const timestamp = (row) => typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;

function validatePage(body) {
  if (!isObject(body) || !Array.isArray(body.data) || !body.data.every(isObject)
      || !Object.hasOwn(body, 'nextCursor')
      || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
    throw new MineError('invalid_response_shape');
  }
  const nextCursor = body.nextCursor || null;
  if (nextCursor && !body.data.length) throw new MineError('empty_cursor_page');
  return { data: body.data, nextCursor };
}

export function createApi({ baseUrl, key, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new MineError('invalid_api_url'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new MineError('invalid_api_url');
  }
  if (!nonempty(key)) throw new MineError('missing_api_key');
  positiveInteger(timeoutMs, 2_147_483_647);
  const root = base.href.replace(/\/$/, '');
  return async (endpoint, params) => {
    const controller = new AbortController();
    let timer;
    try {
      // The deadline covers fetching AND decoding the body, even with an injected
      // fetch that does not honor AbortSignal. No HTTP error body is read/logged.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MineError('request_timeout'));
        }, timeoutMs);
      });
      const request = (async () => {
        const response = await fetchImpl(`${root}/api/v1${endpoint}?${new URLSearchParams(params)}`, {
          method: 'GET', headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' },
          signal: controller.signal, redirect: 'error',
        });
        if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
          throw new MineError('invalid_response_shape');
        }
        if (!response.ok) throw new MineError('http_error', response.status);
        let body;
        try { body = await response.json(); } catch { throw new MineError('invalid_response_json'); }
        return validatePage(body);
      })();
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof MineError) throw error;
      throw new MineError('request_failed');
    } finally {
      clearTimeout(timer);
    }
  };
}

function checkCursor(cursor, seen) {
  if (!cursor) return;
  if (seen.has(cursor)) throw new MineError('repeated_cursor');
  seen.add(cursor);
}

export async function findTables(api) {
  const found = new Map();
  const seen = new Set();
  let cursor;
  do {
    const page = await api('/data-tables', { limit: '100', ...(cursor ? { cursor } : {}) });
    for (const table of page.data) {
      if (!nonempty(table.id) || !nonempty(table.name)) throw new MineError('invalid_table_shape');
      if (TABLES.includes(table.name)) {
        if (found.has(table.name)) throw new MineError('ambiguous_table');
        found.set(table.name, table.id);
      }
    }
    checkCursor(page.nextCursor, seen);
    if (found.size === TABLES.length) return found;
    cursor = page.nextCursor;
  } while (cursor);
  throw new MineError('required_table_missing');
}

/** Verified API contract: descending createdAt, opaque nextCursor. Do not send
 * a createdAt filter (some n8n versions silently ignore it). Stop locally.
 * Completion means the cursor was exhausted or the lower window bound crossed;
 * hitting a budget while a cursor remains is explicitly incomplete.
 */
export async function scanRows(api, tableId, { since, until, limit }) {
  positiveInteger(limit);
  const lower = Date.parse(since);
  const upper = Date.parse(until);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new MineError('invalid_window');
  const rows = [];
  const seen = new Set();
  let cursor;
  let previousTime = Infinity;
  let fetched = 0;
  let pages = 0;
  while (true) {
    const pageSize = Math.min(250, limit - fetched);
    const page = await api(`/data-tables/${encodeURIComponent(tableId)}/rows`, {
      limit: String(pageSize), sortBy: 'createdAt:desc', ...(cursor ? { cursor } : {}),
    });
    pages++;
    if (page.data.length > pageSize) throw new MineError('oversized_page');
    let crossedWindow = false;
    for (const row of page.data) {
      const time = timestamp(row);
      if (!Number.isFinite(time)) throw new MineError('invalid_row_timestamp');
      if (time > previousTime) throw new MineError('rows_not_descending');
      previousTime = time;
      if (time < lower) crossedWindow = true;
      else if (time <= upper) rows.push(row);
    }
    fetched += page.data.length;
    checkCursor(page.nextCursor, seen);
    const stopReason = crossedWindow ? 'window' : !page.nextCursor ? 'exhausted' : fetched >= limit ? 'limit' : null;
    if (stopReason) {
      return { rows, coverage: {
        fetched_rows: fetched, in_window_rows: rows.length, pages,
        stop_reason: stopReason, truncated: stopReason === 'limit',
      } };
    }
    cursor = page.nextCursor;
  }
}

export function isEvalTraffic(row) {
  const session = String(row.session_id || '').trim();
  return String(row.client || '').trim().toLowerCase() === 'eval'
    || /^eval(?:$|[-_/:])/i.test(session)
    || /^phase.*-eval(?:$|[-_/:])/i.test(session);
}

// A null trace is unreadable, not a successful empty trace. Historical gateways
// truncate this JSON string; expose the count rather than declaring tool success.
export function parseTrace(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') return null;
  try {
    const trace = JSON.parse(raw);
    return Array.isArray(trace) && trace.every((t) => isObject(t) && nonempty(t.tool)
      && typeof t.ok === 'boolean' && (t.blocked === undefined || typeof t.blocked === 'boolean')) ? trace : null;
  } catch { return null; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** msgs are chronological. Only the immediately preceding user turn counts;
 * an assistant must be strictly between the users in time (ties are ambiguous).
 */
export function looksReAsk(msgs, idx, windowMs = 5 * 60_000) {
  const cur = msgs[idx];
  if (!cur || cur.role !== 'user') return false;
  for (let j = idx - 1; j >= 0; j--) {
    const prev = msgs[j];
    if (prev.role !== 'user') continue;
    const delta = timestamp(cur) - timestamp(prev);
    if (!(delta > 0 && delta <= windowMs)) return false;
    const answered = msgs.slice(j + 1, idx).some((m) => m.role === 'assistant'
      && timestamp(m) > timestamp(prev) && timestamp(m) < timestamp(cur));
    const a = norm(prev.content);
    return answered && a.length >= 6 && norm(cur.content).includes(a.slice(0, 6));
  }
  return false;
}

export function correlateExecution(row, messages) {
  const empty = { user: null, assistants: [], match: 'none', reAsk: false };
  if (!nonempty(row.session_id) || row.session_id === 'unknown' || !Number.isFinite(timestamp(row))) return empty;
  // Even a matching trace must not pull a future question into this execution.
  const msgs = messages.filter((m) => m.session_id === row.session_id && !isEvalTraffic(m)
    && timestamp(m) <= timestamp(row)).sort((a, b) => timestamp(a) - timestamp(b));
  const traceId = nonempty(row.trace_id) ? row.trace_id : null;
  let idx = traceId ? msgs.findLastIndex((m) => m.role === 'user' && m.trace_id === traceId) : -1;
  let match = 'trace_id';
  if (idx < 0) {
    // Explicitly different traces are not a time-fallback match.
    idx = msgs.findLastIndex((m) => m.role === 'user' && (!traceId || !nonempty(m.trace_id)));
    match = 'time';
  }
  if (idx < 0) return empty;
  const nextUser = msgs.findIndex((m, i) => i > idx && m.role === 'user');
  const assistants = msgs.slice(idx + 1, nextUser < 0 ? msgs.length : nextUser).filter((m) => m.role === 'assistant'
    && (!traceId || !nonempty(m.trace_id) || m.trace_id === traceId));
  return { user: msgs[idx], assistants, match, reAsk: looksReAsk(msgs, idx) };
}

export function mineCandidates(executions, messages, { maxToolRounds = 2 } = {}) {
  positiveInteger(maxToolRounds);
  // Missing client tags on companion rows must not let a known eval session leak
  // back in. Mixed eval/business sessions are conservatively excluded as a whole.
  const evalSessions = new Set([...executions, ...messages].filter(isEvalTraffic)
    .map((row) => row.session_id).filter(nonempty));
  const excluded = (row) => isEvalTraffic(row) || evalSessions.has(row.session_id);
  const execRows = executions.filter((row) => !excluded(row));
  const msgRows = messages.filter((row) => !excluded(row));
  const bySession = new Map();
  for (const msg of msgRows) {
    if (!bySession.has(msg.session_id)) bySession.set(msg.session_id, []);
    bySession.get(msg.session_id).push(msg);
  }
  const warnings = { invalid_tool_traces: 0, unmatched_executions: 0, time_matched_executions: 0 };
  const candidates = [];
  for (const row of execRows) {
    const parsed = parseTrace(row.tool_trace);
    if (parsed === null) warnings.invalid_tool_traces++;
    const trace = parsed || [];
    const turn = correlateExecution(row, bySession.get(row.session_id) || []);
    if (turn.match === 'none') warnings.unmatched_executions++;
    if (turn.match === 'time') warnings.time_matched_executions++;
    const signals = {
      status_error: row.status === 'error',
      tool_error: trace.some((t) => t.ok === false),
      tool_blocked: trace.some((t) => t.blocked === true),
      re_ask: turn.reAsk,
      rounds_at_cap: Number(row.tool_rounds || 0) >= maxToolRounds,
    };
    const score = (signals.status_error ? 3 : 0) + (signals.tool_error ? 2 : 0)
      + (signals.tool_blocked ? 1 : 0) + (signals.re_ask ? 2 : 0) + (signals.rounds_at_cap ? 1 : 0);
    if (!score) continue;
    candidates.push({
      candidate_id: `cand_${String(row.execution_id || row.id || candidates.length).slice(-12)}`,
      session_id: row.session_id || '', trace_id: row.trace_id || '',
      created_at: row.createdAt || '', model: row.model || '', client: row.client || '',
      status: row.status || '', error_code: row.error_code || '',
      error_message: String(row.error_message || '').slice(0, 300),
      latency_ms: row.latency_ms ?? null, tool_rounds: row.tool_rounds ?? null,
      signals, score, tool_trace_valid: parsed !== null,
      tool_trace_summary: trace.map((t) => ({ tool: t.tool, blocked: t.blocked === true, ok: t.ok })).slice(0, 10),
      correlation: turn.match,
      last_user_text: String(turn.user?.content || '').slice(0, 500),
      user_created_at: turn.user?.createdAt || null,
      assistant_texts: turn.assistants.map((m) => String(m.content || '').slice(0, 1000)),
      // Rounds at cap and re-asks are context, NOT a verdict of failure.
      triage: { decision: '', why: '', mapped_tools: '', expected_assertions: '' },
    });
  }
  candidates.sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at));
  return { rows: candidates, warnings, excluded_eval_executions: executions.length - execRows.length,
    excluded_eval_messages: messages.length - msgRows.length };
}

export async function buildReport(api, options, now = new Date(), maxToolRounds = 2) {
  const until = now.toISOString();
  const since = new Date(now.getTime() - options.days * DAY_MS).toISOString();
  const tables = await findTables(api);
  const window = { since, until, limit: options.limit };
  const executions = await scanRows(api, tables.get(TABLES[0]), window);
  const messages = await scanRows(api, tables.get(TABLES[1]), window);
  const mined = mineCandidates(executions.rows, messages.rows, { maxToolRounds });
  const truncated = executions.coverage.truncated || messages.coverage.truncated;
  return {
    generated_at: until, window_days: options.days, window: { since, until },
    limit_per_table: options.limit, truncated, window_scan_complete: !truncated,
    coverage: { executions: executions.coverage, messages: messages.coverage },
    scanned_executions: executions.rows.length, scanned_messages: messages.rows.length,
    candidates: mined.rows.length,
    note: 'Candidates only, not confirmed failures. Human triage.why required. Window scan completeness is not conversation completeness or a consistent database snapshot. Time matches are approximate; future and out-of-window messages are never attached. Local sensitive text: never commit.',
    ...mined,
  };
}

export function writeReport(report, outDir, { nonce = randomUUID } = {}) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(report.generated_at).toISOString().replace(/[:.]/g, '-');
  // Exclusive create is the final guard: even a nonce collision/concurrent run
  // cannot overwrite a triaged report. No daily alias/latest file is maintained.
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = nonce();
    if (!/^[a-zA-Z0-9-]+$/.test(suffix)) throw new MineError('invalid_output_suffix');
    const outFile = path.join(outDir, `candidates-${stamp}-${suffix}.json`);
    try {
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return outFile;
    } catch (error) {
      if (error.code !== 'EEXIST') throw new MineError('report_write_failed');
    }
  }
  throw new MineError('report_name_collision');
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(),
  write = writeReport, log = console.log, errorLog = console.error,
} = {}) {
  try {
    const options = parseArgs(argv);
    if (options.dry) {
      log(JSON.stringify({ dry: true, window_days: options.days, limit_per_table: options.limit,
        page_size_max: 250, timeout_ms: options.timeoutMs, tables: TABLES,
        output: options.outDir === DEFAULT_OUT ? '.eval-local/candidates' : 'custom_directory',
        plan: 'GET table discovery and descending cursor pages, exclude eval, mine candidates, exclusive local report; limit may truncate; no network or disk actions performed' }));
      return 0;
    }
    const maxToolRounds = positiveInteger(env.MAX_TOOL_ROUNDS ?? 2);
    const api = createApi({ baseUrl: env.N8N_URL || 'http://localhost:5678', key: env.N8N_API_KEY,
      timeoutMs: options.timeoutMs, fetchImpl });
    const report = await buildReport(api, options, now(), maxToolRounds);
    const outFile = write(report, options.outDir);
    // stdout is aggregate-only. No candidate ids, sessions, tool names, original
    // messages, upstream errors or caller-selected paths may be printed here.
    log(JSON.stringify({ scanned_executions: report.scanned_executions, scanned_messages: report.scanned_messages,
      candidates: report.candidates, requested_window_days: options.days,
      truncated: report.truncated, window_scan_complete: report.window_scan_complete,
      excluded_eval_executions: report.excluded_eval_executions, excluded_eval_messages: report.excluded_eval_messages,
      warnings: report.warnings, report_file: path.basename(outFile),
      note: 'Candidates only; human triage required. Zero candidates is not a health verdict.' }));
    return 0;
  } catch (error) {
    errorLog(JSON.stringify({ error: error instanceof MineError ? error.code : 'miner_failed',
      ...(error instanceof MineError && error.httpStatus !== undefined ? { http_status: error.httpStatus } : {}) }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
