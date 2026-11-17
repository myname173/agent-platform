#!/usr/bin/env node
/*
 * Offline execution harness for the Code node in workflows/selfcheck.json.
 * Every HTTP call is intercepted and answered from fixtures; API table writes
 * are held in memory. This exercises the self-check's control flow, not the
 * health of a running deployment.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, '../workflows/selfcheck.json');
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const source = workflow.nodes.find((node) => node.name === 'Run Selfcheck')?.parameters?.jsCode;
assert.equal(typeof source, 'string', 'Run Selfcheck Code node must exist');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);
const allowedHosts = new Set([
  'localhost', '127.0.0.1', 'host.docker.internal', 'lobechat', 'minio',
  'n8n-sandbox', 'searxng', 'stream-bridge', 'api.deepseek.com',
]);
const tableNames = [
  'tool_contract', 'selfcheck_runs', 'chat_executions', 'chat_messages', 'todos',
  'reminders', 'people', 'weekly_reviews', 'documents', 'gateway_keys',
  'kb_chunks', 'memories', 'projects', 'alerts', 'delegations',
];
const tables = tableNames.map((name) => ({ id: name, name }));
const columns = {
  tool_contract: ['side', 'tools'],
  selfcheck_runs: ['source', 'total', 'passed', 'failed', 'warned', 'duration_ms', 'checked_at', 'report'],
  chat_executions: ['session_id', 'model', 'client', 'task_lane', 'task_route_reason'],
  chat_messages: ['session_id', 'role', 'content'],
  todos: ['owner_ref', 'ack_at', 'remind_count', 'last_remind_at', 'escalated'],
  reminders: ['owner_ref'],
  weekly_reviews: ['scope', 'people_count'],
  documents: ['title', 'kind', 'html', 'summary', 'source_ref'],
};

async function runScenario({ n8nDown }) {
  const calls = [];
  const memoryRows = new Map();
  const blockedHosts = [];
  const env = {
    CHAT_API_KEY: 'stub-chat-key',
    N8N_API_KEY: 'stub-n8n-key',
    CONSOLE_PORT: '3000',
    LOBECHAT_PORT: '3210',
  };

  const httpRequest = async (options = {}) => {
    const url = new URL(options.url);
    calls.push({ method: String(options.method || 'GET').toUpperCase(), url: url.href });
    if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname)) {
      blockedHosts.push(url.hostname);
      throw new Error('selfcheck stub blocked unmocked host: ' + url.hostname);
    }

    const method = String(options.method || 'GET').toUpperCase();
    const path = url.pathname;
    if (path === '/healthz' && url.hostname === 'localhost' && n8nDown) {
      const error = new Error('fixture: n8n unavailable');
      error.httpCode = 503;
      throw error;
    }
    if (url.hostname === 'n8n-sandbox' && path === '/healthz') return { key_configured: true, python: 'stub-python' };
    if (url.hostname === 'n8n-sandbox' && path === '/run') return { ok: true, stdout: '2\n' };
    if (url.hostname === 'stream-bridge' && path === '/healthz') return { ok: true, tools: [] };
    if (url.hostname === 'api.deepseek.com' && path === '/chat/completions') {
      return { choices: [{ message: { role: 'assistant', content: '本周工作稳步推进，继续关注未完成事项。' } }] };
    }

    if (url.hostname === 'localhost' && path.startsWith('/api/v1/')) {
      const apiPath = path.slice('/api/v1'.length);
      if (apiPath === '/data-tables') return { data: tables };
      const tableMatch = apiPath.match(/^\/data-tables\/([^/]+)(?:\/(columns|rows))?$/);
      if (tableMatch) {
        const [, id, part] = tableMatch;
        if (part === 'columns') return (columns[id] || []).map((name) => ({ name }));
        if (part === 'rows') {
          if (method === 'POST') {
            const rows = Array.isArray(options.body?.data) ? options.body.data : [];
            memoryRows.set(id, [...(memoryRows.get(id) || []), ...rows]);
            return { data: rows };
          }
          if (method === 'GET') {
            if (id === 'tool_contract') return { data: [{ side: 'gateway', tools: '' }, { side: 'stream-bridge', tools: '' }] };
            return { data: memoryRows.get(id) || [] };
          }
        }
      }
      if (apiPath.startsWith('/workflows')) return { data: [{ id: 'workflow-stub', name: 'fixture' }] };
      return { data: [] };
    }

    if (url.hostname === 'minio' && method === 'OPTIONS') {
      return { statusCode: 204, headers: { 'access-control-allow-origin': 'http://127.0.0.1:3210', 'access-control-allow-methods': 'GET, PUT, POST, DELETE' }, body: '' };
    }

    if (url.hostname === 'localhost' && path === '/webhook/v1/chat/completions') {
      if (!options.headers?.Authorization) {
        const error = new Error('fixture: unauthorized');
        error.httpCode = 401;
        throw error;
      }
      return { choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    }

    if (path === '/webhook/admin/tools') return { tools: [] };
    if (path === '/webhook/admin/lobehub-config') return { ok: true, drift: [] };
    if (path === '/webhook/admin/docforge') return { ok: true, docs: [] };
    if (path === '/webhook/internal/memory') return url.searchParams.get('action') === 'list'
      ? { ok: true, counts: { mine: 0, lobe: 0 } }
      : { ok: true, failed: 0, mirrored: 0 };
    if (path === '/webhook/admin/delegation') return { ok: true, totals: { assigned_open: 0, awaiting_ack: 0, overdue: 0 }, people: [] };
    if (path === '/webhook/admin/people') return { ok: true, count: 0, people: [] };
    if (path === '/webhook/admin/todos') return { ok: true, assigned_count: 0, people: [], open: [], owner_filter: url.searchParams.get('owner') || 'all' };
    if (path === '/webhook/admin/weekly-review/run') return { ok: true, scope: 'team', content: '团队复盘 fixture', people_count: 0, chars: 8 };
    if (path === '/webhook/admin/alerts') return { ok: true, alerts: [], count: 0 };
    if (path === '/webhook/admin/alerts/run') return { ok: true };
    if (path === '/webhook/internal/notify') return { ok: true };
    if (path === '/webhook/admin/overview') return { ok: true };
    if (path === '/webhook/admin/kb/ingest') return { ok: true, accepted: 0 };
    if (path === '/webhook/mcp') return { ok: true, result: {} };
    if (path === '/webhook/v1/stats/executions') return { data: [], total: 0 };
    if (url.hostname === 'searxng' && path === '/search') return { results: [], unresponsive_engines: [] };
    if (url.hostname === 'searxng' && path === '/') return { ok: true };

    if (options.returnFullResponse) return { statusCode: 200, headers: {}, body: '' };
    return {};
  };

  const context = {
    helpers: { httpRequest },
  };
  const execute = new AsyncFunction('$env', '$input', '$', '$getWorkflowStaticData', 'require', source);
  const result = await execute.call(
    context,
    env,
    { first: () => ({ json: {} }) },
    () => { throw new Error('manual trigger not present in scheduled fixture'); },
    () => ({}),
    require,
  );
  const output = result?.[0]?.json;
  assert.equal(typeof output, 'object', 'self-check Code node must return an item');
  assert.equal(output.total, 49, 'all 49 checks should be registered and executed');
  assert.equal(output.persisted, true, 'selfcheck_runs persistence should use the in-memory table fixture');
  assert.deepEqual(blockedHosts, [], 'no real or unmocked network hosts may be used');
  assert.ok(calls.length > 0, 'the scenario should exercise the HTTP mock');
  return { output, calls: calls.length, writes: (memoryRows.get('selfcheck_runs') || []).length, blockedHosts };
}

const healthy = await runScenario({ n8nDown: false });
const degraded = await runScenario({ n8nDown: true });
assert.ok(!healthy.output.failures.includes('n8n healthz'), 'healthy fixture should pass the n8n health check');
assert.ok(degraded.output.failures.includes('n8n healthz'), 'negative fixture should detect the simulated n8n outage');

console.log(JSON.stringify({
  mode: 'offline-stub-only',
  checksExercisedPerScenario: healthy.output.total,
  n8nUpFixture: { healthzPassed: !healthy.output.failures.includes('n8n healthz'), otherFixtureFailures: healthy.output.failures, calls: healthy.calls, inMemoryWrites: healthy.writes },
  negativeControl: { n8nHealthzDetectedDown: degraded.output.failures.includes('n8n healthz'), fixtureFailures: degraded.output.failures, calls: degraded.calls, inMemoryWrites: degraded.writes },
  note: 'Fixture results exercise self-check control flow only; they do not report deployment health.',
}, null, 2));
