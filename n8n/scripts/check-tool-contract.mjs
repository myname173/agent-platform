#!/usr/bin/env node
/**
 * B2 · 工具契约一致性检查。
 *
 * 平台有两份独立的工具定义，必须保持一致：
 *   1. 网关  n8n/workflows/chat-gateway.json  → Build Upstream Payload 的 TOOLS 数组
 *   2. 侧车  stream-bridge/server.js          → SERVER_TOOLS
 *
 * 它们历史上靠手工同步，已经踩过坑：漏改一处就会出现「模型看得到工具但参数丢失」，
 * 而且不会报错，只是行为变差。这个脚本把两份定义做差集，不一致就非零退出。
 *
 * Usage: node n8n/scripts/check-tool-contract.mjs
 * Exit:  0 = 一致；1 = 有差异；2 = 解析失败
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 从一段代码里抽取 TOOLS/SERVER_TOOLS 数组中的工具名 */
function namesFromArrayLiteral(code, startMarker) {
  const start = code.indexOf(startMarker);
  if (start < 0) return null;
  // 从起始标记往后找到配对的 '];'
  const end = code.indexOf('];', start);
  if (end < 0) return null;
  const region = code.slice(start, end);
  const names = [...region.matchAll(/name:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  return [...new Set(names)];
}

function gatewayTools() {
  const wf = JSON.parse(readFileSync(join(root, 'n8n', 'workflows', 'chat-gateway.json'), 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Build Upstream Payload');
  if (!node || !node.parameters || !node.parameters.jsCode) return null;
  return namesFromArrayLiteral(node.parameters.jsCode, 'const TOOLS = [');
}

function sidecarTools() {
  const src = readFileSync(join(root, 'stream-bridge', 'server.js'), 'utf8');
  return namesFromArrayLiteral(src, 'const SERVER_TOOLS = [');
}

const gw = gatewayTools();
const sc = sidecarTools();

if (!gw || !sc) {
  console.error('failed to parse tool definitions (gateway=' + (gw ? gw.length : 'null') + ', sidecar=' + (sc ? sc.length : 'null') + ')');
  process.exit(2);
}

const gwSet = new Set(gw);
const scSet = new Set(sc);
const onlyGateway = gw.filter((n) => !scSet.has(n));
const onlySidecar = sc.filter((n) => !gwSet.has(n));

console.log('gateway tools (' + gw.length + '): ' + gw.join(', '));
console.log('sidecar tools (' + sc.length + '): ' + sc.join(', '));

if (!onlyGateway.length && !onlySidecar.length) {
  console.log('tool contract OK — both sides agree on ' + gw.length + ' tools');
  process.exit(0);
}

console.error('');
console.error('TOOL CONTRACT MISMATCH');
if (onlyGateway.length) console.error('  only in gateway: ' + onlyGateway.join(', '));
if (onlySidecar.length) console.error('  only in sidecar: ' + onlySidecar.join(', '));
console.error('  → update the other side so both define the same tool set');
process.exit(1);
