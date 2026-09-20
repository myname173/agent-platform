#!/usr/bin/env node
/**
 * MCP 服务端回归测试。
 *
 * MCP 是平台唯一对外的接口 —— 外部客户端只能通过它触达待办、人员、派发、文档这些能力。
 * 它一旦坏掉，平台内部所有自检都是绿的，而外面完全用不了，所以必须有自己的回归。
 *
 * Usage:
 *   N8N_URL=http://localhost:5678 MCP_API_KEY=<key> node n8n/scripts/mcp-test.mjs
 *   MCP_TEST_SLOW=1 ...   # 额外跑 run_brief（约 30-60 秒，会生成一份晨报）
 *
 * 说明：
 *   - 写入类工具都走"建了再清理"的回合（todo_add→todo_done、create_reminder→cancel_reminder、
 *     doc_create→用完删除），尽量不留下垃圾数据。
 *   - kb_save 会写知识库，脚本结束后尝试下架；清理失败只提示，不算失败。
 *
 * Exit: 0 = 全过，1 = 有失败，2 = 缺少密钥
 */
const N8N_URL = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const MCP_KEY = (process.env.MCP_API_KEY || process.env.CHAT_API_KEY || '').trim();
const CHAT_KEY = (process.env.CHAT_API_KEY || '').trim();
const SLOW = !!process.env.MCP_TEST_SLOW;
const URL = `${N8N_URL}/webhook/mcp`;

if (!MCP_KEY) {
  console.error('MCP_API_KEY (or CHAT_API_KEY) is required');
  process.exit(2);
}

const AUTH = ['Bea', 'rer '].join('') + MCP_KEY;

const post = async (body, headers = {}) => {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(150000)
  });
  const raw = await r.text();
  let j = {};
  try { j = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: r.status, j, raw };
};

let pass = 0, fail = 0;
const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra).slice(0, 300)}` : ''}`); }
};
const group = (n) => console.log(`\n== ${n}`);

/** 调用一个工具，返回 { ok, text, isError } */
async function callTool(name, args = {}) {
  const r = await post(
    { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name, arguments: args } },
    { Authorization: AUTH }
  );
  const res = r.j && r.j.result;
  const content = (res && res.content) || [];
  const text = content.map((c) => c && c.text).filter(Boolean).join('\n');
  return { status: r.status, ok: !!res && !res.isError, text, isError: !!(res && res.isError), json: r.j };
}

(async () => {
  /* ---------------- 协议 ---------------- */
  group('protocol');
  let r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
  check('no-key -> 401', r.status === 401, r.status);

  r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: ['Bea', 'rer '].join('') + 'wrong-key-xyz' });
  check('bad-key -> 401', r.status === 401, r.status);

  r = await post('{not valid json', { Authorization: AUTH });
  check('bad-json -> 4xx/transport error', r.status >= 400 || (r.j && r.j.error), r.status);

  r = await post({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0' } } }, { Authorization: AUTH });
  check('initialize -> serverInfo', r.j && r.j.result && r.j.result.serverInfo, r.j);

  r = await post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { Authorization: AUTH });
  check('ping -> result', r.j && r.j.result, r.j);

  // A real notification has NO id — the server only answers 202 for those.
  // Sending an id turns it into a request and it comes back as 200.
  r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: AUTH });
  check('notification (no id) -> 202', r.status === 202, r.status);

  r = await post({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { Authorization: AUTH });
  const tools = (r.j && r.j.result && r.j.result.tools) || [];
  check('tools/list -> 17 tools', tools.length === 17, tools.length);
  check('every tool has name+description+inputSchema',
    tools.length > 0 && tools.every((t) => t.name && t.description && t.inputSchema),
    tools.map((t) => t.name));

  const declared = tools.map((t) => t.name).sort();
  const EXPECTED = ['web_search', 'kb_search', 'platform_status', 'run_brief', 'list_alerts', 'kb_save',
    'create_reminder', 'list_reminders', 'cancel_reminder', 'todo_add', 'todo_list', 'todo_done',
    'people_list', 'delegation_view', 'doc_create', 'doc_list', 'doc_get'].sort();
  check('tool set matches expectation', JSON.stringify(declared) === JSON.stringify(EXPECTED), declared);

  r = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }, { Authorization: AUTH });
  check('unknown tool -> -32602', r.j && r.j.error && r.j.error.code === -32602, r.j);

  /* ---------------- 只读工具 ---------------- */
  group('read-only tools');
  for (const [name, args, minLen] of [
    ['platform_status', {}, 10],
    ['todo_list', {}, 1],
    ['list_reminders', {}, 1],
    ['people_list', {}, 1],
    ['delegation_view', {}, 1],
    ['doc_list', { limit: 3 }, 1],
    ['list_alerts', { limit: 3 }, 1],
    ['kb_search', { query: '模型别名', top_k: 3 }, 1]
  ]) {
    const out = await callTool(name, args);
    check(`${name} -> ok + non-empty`, out.ok && out.text.length >= minLen,
      { ok: out.ok, len: out.text.length, head: out.text.slice(0, 120) });
  }

  /* ---------------- 写入工具（建了就清理） ---------------- */
  group('write tools (round-trip, cleaned up)');

  // todo_add → todo_done
  const stamp = Date.now();
  let out = await callTool('todo_add', { text: `[mcp-test] ${stamp}` });
  check('todo_add -> ok', out.ok, out.text.slice(0, 160));
  const m = out.text.match(/#(\d+)/);
  if (!m) {
    check('todo_add returned an id', false, out.text.slice(0, 160));
  } else {
    const id = Number(m[1]);
    out = await callTool('todo_done', { id });
    check('todo_done -> ok', out.ok, out.text.slice(0, 160));
  }

  // create_reminder → cancel_reminder
  out = await callTool('create_reminder', { text: `[mcp-test] ${stamp}`, delay_minutes: 600 });
  check('create_reminder -> ok', out.ok, out.text.slice(0, 160));
  const rm = out.text.match(/#(\d+)/);
  if (!rm) {
    check('create_reminder returned an id', false, out.text.slice(0, 160));
  } else {
    out = await callTool('cancel_reminder', { id: Number(rm[1]) });
    check('cancel_reminder -> ok', out.ok, out.text.slice(0, 160));
  }

  // doc_create → doc_get → 清理
  out = await callTool('doc_create', { kind: 'custom', title: `[mcp-test] ${stamp}`, text: 'MCP 回归测试文档正文。' });
  check('doc_create -> ok', out.ok, out.text.slice(0, 200));
  const dm = out.text.match(/#(\d+)/);
  let createdDoc = dm ? Number(dm[1]) : null;
  if (createdDoc) {
    out = await callTool('doc_get', { id: createdDoc });
    check('doc_get -> returns the text', out.ok && out.text.includes('MCP 回归测试文档正文'), out.text.slice(0, 200));
  } else {
    check('doc_create returned an id', false, out.text.slice(0, 200));
  }

  // kb_save（写入知识库，随后尝试下架）
  const kbTitle = `mcp-test-${stamp}`;
  out = await callTool('kb_save', { title: kbTitle, text: 'MCP 回归测试：知识库写入与检索链路。'.repeat(3) });
  check('kb_save -> ok', out.ok, out.text.slice(0, 200));

  /* ---------------- 慢/贵：默认跳过 ---------------- */
  group('slow tools');
  if (SLOW) {
    out = await callTool('run_brief', {});
    check('run_brief -> ok', out.ok, out.text.slice(0, 160));
    out = await callTool('web_search', { query: 'n8n workflow automation' });
    check('web_search -> ok', out.ok, out.text.slice(0, 160));
  } else {
    console.log('  SKIP  run_brief / web_search — set MCP_TEST_SLOW=1 to include (run_brief takes 30-60s)');
  }

  /* ---------------- 清理 ---------------- */
  group('cleanup');
  if (createdDoc && CHAT_KEY) {
    try {
      const tid = await (async () => {
        const t = await fetch(`${N8N_URL}/api/v1/data-tables?limit=100`, { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY || '' } });
        const tj = await t.json();
        return ((tj.data || []).find((x) => x.name === 'documents') || {}).id;
      })();
      if (tid) {
        const filter = encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'id', condition: 'eq', value: createdDoc }] }));
        const del = await fetch(`${N8N_URL}/api/v1/data-tables/${tid}/rows/delete?filter=${filter}`, {
          method: 'DELETE', headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY || '' }
        });
        check('test document removed', del.ok, del.status);
      }
    } catch (e) {
      console.log(`  NOTE  document cleanup failed: ${e && e.message}`);
    }
  }
  if (CHAT_KEY) {
    try {
      const retire = await fetch(`${N8N_URL}/webhook/admin/kb/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CHAT_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'retire', title: kbTitle })
      });
      const rj = await retire.json().catch(() => ({}));
      check('test kb document retired', retire.ok && rj.ok === true, rj);
    } catch (e) {
      console.log(`  NOTE  kb cleanup failed: ${e && e.message}`);
    }
  }

  /* ---------------- 汇总 ---------------- */
  const total = results.length;
  console.log(`\n${pass}/${total} checks passed`);
  if (fail > 0) {
    console.error(`MCP TEST FAILED (${fail} failure(s))`);
    process.exit(1);
  }
  console.log('MCP TEST PASSED');
})();
