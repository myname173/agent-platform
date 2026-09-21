#!/usr/bin/env node
/**
 * 客户端工具路径回归测试（2026-09-21 新增）。
 *
 * 为什么需要单独一条：平台有四个入口，只有 LobeHub 会在请求里带自己的
 * client_tools。这条路径启用网关里的一段分支逻辑
 * （Check Response 的「服务端 / 客户端工具分类」），而冒烟、自检、MCP 回归
 * 三条门**都不走这里**。
 *
 * 2026-09-21 实测：该分支用一份硬编码的 SERVER_NAMES 判断归属，落后于真正的
 * 工具表（缺 run_python / mcp_list_tools / mcp_call）。结果是这三个工具被判成
 * 客户端工具 → 网关整条响应透传、自己不执行 → 用户收到一条 tool_calls 却没人跑，
 * 表现为「发了一句，AI 没回话」。当时 smoke 71/71、自检 43/43、MCP 27/27 全绿。
 *
 * 本测试守住这条路径：只要再次出现「服务端工具被原样透传且没有执行」就红。
 *
 * Usage: node --env-file=.env n8n/scripts/test-client-tools.mjs
 * Exit:  0 = 通过；1 = 发现透传回归；2 = 无法判定（环境问题，不算通过）
 */

import { readFileSync } from 'node:fs';

const GATEWAY = process.env.N8N_URL ? process.env.N8N_URL.replace(/\/$/, '') + '/webhook/v1/chat/completions'
  : 'http://localhost:5678/webhook/v1/chat/completions';
const KEY = process.env.CHAT_API_KEY || '';
if (!KEY) {
  console.error('CHAT_API_KEY is not set (run with --env-file=.env)');
  process.exit(2);
}

/* 已知的服务器工具名 —— 若它们被原样透传回客户端，说明分类逻辑坏了 */
const SERVER_TOOLS = new Set([
  'web_search', 'kb_search', 'platform_status', 'run_brief', 'list_alerts', 'kb_save',
  'create_reminder', 'list_reminders', 'cancel_reminder', 'todo_add', 'todo_list', 'todo_done',
  'run_python', 'mcp_list_tools', 'mcp_call',
]);

const CLIENT_TOOL = {
  type: 'function',
  function: {
    name: 'ui_local_tool',
    description: 'A tool implemented by the chat UI, not by the platform.',
    parameters: { type: 'object', properties: {} },
  },
};

async function ask(text, withClientTools) {
  const body = {
    model: 'deepseek-agent',
    messages: [{ role: 'user', content: text }],
    ...(withClientTools ? { tools: [CLIENT_TOOL] } : {}),
  };
  const r = await fetch(GATEWAY, {
    method: 'POST',
    headers: { Authorization: 'Bea' + 'rer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { httpError: r.status };
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  return {
    rounds: j.tool_rounds,
    returned: (msg.tool_calls || []).map((c) => c.function?.name),
    content: msg.content || '',
  };
}

const QUESTION = 'Use the run_python tool to compute 12345 * 6789 and tell me the result.';
const ATTEMPTS = 3;
let checked = 0;
const failures = [];

for (let i = 1; i <= ATTEMPTS; i++) {
  const r = await ask(QUESTION, true);
  if (r.httpError) {
    console.log('attempt ' + i + ': HTTP ' + r.httpError + ' (gateway error)');
    continue;
  }
  const leaked = r.returned.filter((n) => SERVER_TOOLS.has(n));
  const executed = (r.rounds || 0) >= 1;
  console.log('attempt ' + i + ': tool_rounds=' + JSON.stringify(r.rounds) +
    ' returned=[' + r.returned.join(', ') + '] content=' + (r.content ? r.content.slice(0, 40).replace(/\n/g, ' ') : '(empty)'));

  if (leaked.length) {
    checked++;
    failures.push('attempt ' + i + ': server tool(s) passed through unexecuted: ' + leaked.join(', ') +
      ' (tool_rounds=' + JSON.stringify(r.rounds) + ', content empty=' + (r.content === '') + ')');
  } else if (executed) {
    checked++;
  }
}

console.log('');
if (failures.length) {
  console.error('CLIENT-TOOL PATH REGRESSION (' + failures.length + '/' + checked + ')');
  for (const f of failures) console.error('  - ' + f);
  console.error('  → server tools are being classified as client tools and skipped');
  console.error('  → check Check Response: SERVER_NAMES must derive from base_meta.server_tools');
  process.exit(1);
}
if (!checked) {
  console.error('inconclusive: the model never exercised a server tool in ' + ATTEMPTS + ' attempt(s)');
  process.exit(2);
}
console.log('client-tool path OK — ' + checked + '/' + ATTEMPTS + ' attempt(s) executed server tools, none leaked through');
process.exit(0);
