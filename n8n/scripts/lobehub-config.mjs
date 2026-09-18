#!/usr/bin/env node
/**
 * L1 · LobeHub 关键配置的检查与修复。
 *
 * 这些开关（enableResponseApi / searchMode / useModelBuiltinSearch /
 * system_agent / memory）当年是直接改数据库达成的，没有沉淀成代码。
 * 结果是一次「从旧备份恢复」就可能把它们打回未接线状态，而症状只是
 * 「AI 突然不听话了」，极难归因。这个脚本把它们变成可检查、可重放的东西。
 *
 * Usage:
 *   N8N_URL=http://localhost:5678 CHAT_API_KEY=<key> node n8n/scripts/lobehub-config.mjs          # 只检查
 *   N8N_URL=http://localhost:5678 CHAT_API_KEY=<key> node n8n/scripts/lobehub-config.mjs apply    # 修复
 *
 * Exit code: 0 = 一致（或修复成功）；1 = 检查时发现漂移；2 = 调用失败
 */

const N8N_URL = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_API_KEY = process.env.CHAT_API_KEY;
const action = process.argv[2] === 'apply' ? 'apply' : 'status';

if (!CHAT_API_KEY) {
  console.error('CHAT_API_KEY is required');
  process.exit(2);
}

const res = await fetch(`${N8N_URL}/webhook/admin/lobehub-config`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${CHAT_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action }),
}).catch((e) => {
  console.error('request failed: ' + e.message);
  process.exit(2);
});

let body = null;
try {
  body = await res.json();
} catch {
  /* ignore */
}

if (!res.ok || !body || body.ok !== true) {
  console.error('lobehub-config failed: ' + JSON.stringify(body || res.status));
  process.exit(2);
}

const drift = body.drift || [];
const changes = body.changes || [];

if (action === 'status') {
  if (drift.length === 0) {
    console.log('LobeHub config: in sync');
    process.exit(0);
  }
  console.log('LobeHub config: ' + drift.length + ' item(s) drifted');
  drift.forEach((d) => console.log('  - ' + d));
  console.log('run with "apply" to heal');
  process.exit(1);
}

if (changes.length === 0) {
  console.log('LobeHub config: already in sync, nothing to do');
} else {
  console.log('LobeHub config: healed ' + changes.length + ' item(s)');
  changes.forEach((c) => console.log('  - ' + c));
}
process.exit(0);
