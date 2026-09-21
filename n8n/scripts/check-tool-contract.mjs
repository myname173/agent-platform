#!/usr/bin/env node
/**
 * B2 · 工具契约一致性检查（强化版）。
 *
 * 背景：2026-09-21 发现网关里曾有 **四份** 服务器工具定义：
 *   1. build-upstream      → const TOOLS（第 1 轮下发）      15 个
 *   2. append-tool-results → const TOOLS（第 2 轮重建）      12 个  ← 漂移
 *   3. check-response      → SERVER_NAMES（服务端/客户端分类） 12 个  ← 漂移
 *   4. 侧车 server.js      → SERVER_TOOLS                    15 个
 *
 * 而旧版本脚本只比 1 和 4，所以 **四份里有两份错了，门却是绿的**。后果：
 *   - 第 2 轮工具循环里 run_python / mcp_list_tools / mcp_call 和全部 wf_* 消失
 *   - 带 client_tools 的客户端（LobeHub）上，这三个工具被误判成客户端工具，
 *     网关直接透传上游响应、根本不执行 —— 功能静默死亡
 * 而 MCP 回归 / 自检 / 冒烟全绿，因为它们都不走那条路径。
 *
 * 修法是让 2、3 从 1 推导（单一事实源），本脚本则改为守住这个结构：
 *   A. 网关规范清单  vs  侧车 SERVER_TOOLS
 *   B. 声明的工具  ⊆  Execute Tool 真正实现的工具
 *   C. 不得重新出现硬编码副本（防复发）
 *
 * Usage: node n8n/scripts/check-tool-contract.mjs
 * Exit:  0 = 通过；1 = 契约违反；2 = 解析失败
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readWorkflow() {
  return JSON.parse(readFileSync(join(root, 'n8n', 'workflows', 'chat-gateway.json'), 'utf8'));
}
function nodeCode(wf, id) {
  const n = wf.nodes.find((x) => x.id === id);
  return n && n.parameters && n.parameters.jsCode ? n.parameters.jsCode : '';
}

/** 从 `const TOOLS = [` 这类数组字面量里抽工具名 */
function arrayLiteralNames(code, marker) {
  const s = code.indexOf(marker);
  if (s < 0) return null;
  const e = code.indexOf('];', s);
  if (e < 0) return null;
  return [...new Set([...code.slice(s, e).matchAll(/name:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];
}

const wf = readWorkflow();
const buildCode = nodeCode(wf, 'build-upstream');
const appendCode = nodeCode(wf, 'p5-append-tool-results');
const checkCode = nodeCode(wf, 'p5-check-response');
const execCode = nodeCode(wf, 'p5b-execute-tool');
const sidecarSrc = readFileSync(join(root, 'stream-bridge', 'server.js'), 'utf8');

const gateway = arrayLiteralNames(buildCode, 'const TOOLS = [');
const sidecar = arrayLiteralNames(sidecarSrc, 'const SERVER_TOOLS = [');
/** Execute Tool 里 `it.tool_name === 'xxx'` 的所有分支 */
const implemented = [...new Set([...execCode.matchAll(/tool_name\s*===\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];

const problems = [];

if (!gateway || !sidecar || !implemented.length) {
  console.error('failed to parse tool definitions');
  console.error('  gateway=' + (gateway ? gateway.length : 'null') + ' sidecar=' + (sidecar ? sidecar.length : 'null') + ' implemented=' + implemented.length);
  process.exit(2);
}

console.log('gateway canonical   (' + gateway.length + '): ' + gateway.join(', '));
console.log('sidecar SERVER_TOOLS(' + sidecar.length + '): ' + sidecar.join(', '));
console.log('gateway implemented (' + implemented.length + '): ' + implemented.join(', '));
console.log('');

/* ---- A. 网关 vs 侧车 ---- */
const gwSet = new Set(gateway);
const scSet = new Set(sidecar);
const onlyGw = gateway.filter((n) => !scSet.has(n));
const onlySc = sidecar.filter((n) => !gwSet.has(n));
if (onlyGw.length || onlySc.length) {
  if (onlyGw.length) problems.push('only in gateway: ' + onlyGw.join(', '));
  if (onlySc.length) problems.push('only in sidecar: ' + onlySc.join(', '));
} else {
  console.log('A. gateway <-> sidecar : OK (' + gateway.length + ' tools)');
}

/* ---- B. 声明的必须都被实现 ---- */
const notImplemented = gateway.filter((n) => !implemented.includes(n));
if (notImplemented.length) {
  problems.push('declared but not implemented in Execute Tool: ' + notImplemented.join(', '));
} else {
  console.log('B. declared ⊆ implemented : OK (' + gateway.length + '/' + gateway.length + ')');
}

/* ---- C. 不得重新出现硬编码副本 ---- */
const stale = [];
if (/const\s+TOOLS\s*=\s*\[/.test(appendCode)) {
  stale.push("append-tool-results still defines 'const TOOLS = [' (must reuse server_tools)");
}
if (/SERVER_NAMES\s*=\s*new\s+Set\(\s*\[/.test(checkCode)) {
  stale.push("check-response still hardcodes 'SERVER_NAMES = new Set([...])' (must derive from server_tools)");
}
if (!/server_tools/.test(buildCode)) {
  stale.push('build-upstream no longer emits server_tools');
}
if (!/server_tools/.test(appendCode)) {
  stale.push('append-tool-results no longer threads server_tools');
}
if (!/base_meta\.server_tools/.test(checkCode)) {
  stale.push('check-response no longer derives SERVER_NAMES from base_meta.server_tools');
}
if (stale.length) {
  problems.push(...stale);
} else {
  console.log('C. single source of truth : OK (no duplicated literals, server_tools threaded)');
}

console.log('');
if (!problems.length) {
  console.log('tool contract OK — ' + gateway.length + ' tools, one definition, fully implemented');
  process.exit(0);
}

console.error('TOOL CONTRACT VIOLATION (' + problems.length + ')');
for (const p of problems) console.error('  - ' + p);
console.error('  → see header of this script for why duplicates are dangerous');
process.exit(1);
