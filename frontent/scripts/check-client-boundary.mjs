#!/usr/bin/env node
/**
 * 客户端边界检查：客户端组件不得直接引用带密钥的服务端客户端。
 *
 * lib/n8n-client 里的函数会带上 CHAT_API_KEY / N8N_API_KEY —— 都是服务端专用变量
 * （非 NEXT_PUBLIC_），打包进浏览器后是空字符串。客户端组件一旦直接调用，请求就不带
 * 凭据、被 n8n 拒掉，而界面上只会看到一句笼统的"失败"，很难归因。
 *
 * 客户端一律应走 /api/n8n/* 路由，由 Route Handler 在服务端带密钥转发。
 *
 * Usage: node frontent/scripts/check-client-boundary.mjs
 * Exit:  0 = 干净，1 = 发现违规
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');
const TARGET = '@/lib/n8n-client';

const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
};

/** 判断 import 是否只引入类型（type-only 会在编译期擦除，不带运行时代码，安全） */
const isTypeOnly = (stmt) =>
  stmt.includes('import type') ||
  /^\s*import\s*\{[^}]*\}\s*from/.test(stmt) === false ||
  // `import { type X }` / `import { type X, type Y }`：所有说明符都以 type 开头
  (() => {
    const m = stmt.match(/import\s*\{([^}]*)\}\s*from/);
    if (!m) return false;
    const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    return specifiers.length > 0 && specifiers.every((s) => s.startsWith('type '));
  })();

const offenders = [];
for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes("'use client'")) continue;
  for (const line of src.split(/\r?\n/)) {
    if (!line.includes(TARGET)) continue;
    if (isTypeOnly(line)) continue;
    offenders.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: line.trim() });
    break;
  }
}

if (offenders.length === 0) {
  console.log('client boundary OK — no client component imports n8n-client for values');
  process.exit(0);
}

console.error(`client boundary VIOLATION — ${offenders.length} file(s) import n8n-client for values:`);
for (const o of offenders) console.error(`  ${o.file}\n    ${o.line}`);
console.error(`\n客户端组件请改为 fetch('/api/n8n/...')，让密钥留在服务端。`);
process.exit(1);
