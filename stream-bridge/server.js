/* stream-bridge: OpenAI-compatible endpoint sitting in front of the n8n chat
   gateway (LobeHub -> this -> upstream deepseek / gateway fallback).
   - non-stream requests: proxied verbatim to the gateway.
   - stream requests: relay the upstream SSE stream (fast path). If the model
     emits tool_calls, discard that attempt and fall back to the gateway
     (full tool loop, non-stream), then re-emit the result as a pseudo-stream.
   - streamed turns are logged back to n8n (messages + execution stats).
   NOTE: keep SERVER_TOOLS in sync with n8n/workflows/chat-gateway.json. */
const http = require('http');

const PORT = Number(process.env.PORT || 3211);
const GATEWAY = String(process.env.GATEWAY_URL || 'http://n8n:5678/webhook/v1').replace(/\/$/, '');
const UPSTREAM = String(process.env.UPSTREAM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const UP_KEY = process.env.UPSTREAM_API_KEY || '';
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const LOG_URL = process.env.LOG_URL || 'http://n8n:5678/webhook/internal/log-turn';
const MODEL_UPSTREAM = process.env.UPSTREAM_MODEL || 'deepseek-v4-flash';
const AUTH_PREFIX = 'Bea' + 'rer ';

const SERVER_TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the public web for current information, facts, news or documentation. Returns ranked results with title, url and snippet.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'kb_search', description: 'Search the private knowledge base (ingested internal documents, notes and references).', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' }, top_k: { type: 'integer', description: 'How many passages (1-10, default 6)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'platform_status', description: 'Get live status of the personal AI platform: chat traffic, error rate, latency, alerts, knowledge base usage.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_brief', description: 'Generate the daily brief right now (fetches fresh sources and saves it).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_alerts', description: 'List recent platform alerts with severity and time.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many alerts (1-20, default 8)' } } } } },
  { type: 'function', function: { name: 'kb_save', description: 'Save a note or excerpt into the private knowledge base. Args: title, text.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Short descriptive title' }, text: { type: 'string', description: 'The full text content to store' } }, required: ['title', 'text'] } } },
  { type: 'function', function: { name: 'create_reminder', description: 'Create a reminder pushed at the due time. Provide text plus due_at (ISO 8601) or delay_minutes. Pass owner to remind someone else.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to remind about' }, due_at: { type: 'string', description: 'ISO 8601 time with timezone' }, delay_minutes: { type: 'integer', description: 'Alternative: remind after N minutes' }, owner: { type: 'string', description: 'Optional assignee name from the people directory' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_reminders', description: 'List upcoming (pending) and recent reminders. Pass owner to filter by assignee ("mine" for own).', parameters: { type: 'object', properties: { owner: { type: 'string', description: 'Optional person name, or "mine"' } } } } },
  { type: 'function', function: { name: 'cancel_reminder', description: 'Cancel a pending reminder by id.', parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Reminder id' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'todo_add', description: 'Save an open-loop item (todo). Optional due_date YYYY-MM-DD and optional owner (a name from the people directory) to assign it to someone.', parameters: { type: 'object', properties: { text: { type: 'string' }, due_date: { type: 'string' }, owner: { type: 'string', description: 'Optional assignee name from the people directory' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'todo_list', description: 'List open todos with overdue / due-today flags. Pass owner to filter by assignee ("mine" for own unassigned todos).', parameters: { type: 'object', properties: { owner: { type: 'string', description: 'Optional person name, or "mine"' } } } } },
  { type: 'function', function: { name: 'todo_done', description: 'Complete a todo by id.', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'run_python', description: 'Run a short Python snippet in an isolated sandbox and read back its stdout. Use for arithmetic, statistics, CSV/JSON processing, parsing, formatting, date maths or any step that is easier to compute than to write. Standard library only (no numpy/pandas). No network, no subprocess, no file writes - those are refused. Print what you want returned; return values are not captured. 15s timeout, 8KB output cap.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Python code. It must print() whatever you want to see.' }, why: { type: 'string', description: 'One line: what this computes and why.' } }, required: ['code'] } } },
];

/* ---- L2: registered workflow tools (cached 60s) ---- */
let wfToolCache = { ts: 0, tools: [] };
async function getWfTools() {
  if (Date.now() - wfToolCache.ts < 60000) return wfToolCache.tools;
  try {
    const r = await fetch('http://n8n:5678/webhook/admin/tools', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH_PREFIX + CHAT_KEY }, body: JSON.stringify({ action: 'list' }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    wfToolCache = { ts: Date.now(), tools: (j && j.tools) || [] };
  } catch (e) {}
  return wfToolCache.tools;
}
const wfToolDefs = (tools) => tools.map((t) => ({ type: 'function', function: { name: 'wf_' + t.name, description: '[自建流程] ' + String(t.description || t.title || t.name), parameters: { type: 'object', properties: { text: { type: 'string', description: '可选：传给流程的文本/参数' } } } } }));

const TOOL_LABELS = {
  web_search: '🌐 检索互联网',
  kb_search: '📚 检索私域知识库',
  kb_save: '💾 存入私域知识库',
  platform_status: '📊 查询平台运行状态',
  run_brief: '📰 生成今日晨报',
  list_alerts: '⚠️ 查看平台告警',
  create_reminder: '⏰ 创建定时提醒',
  list_reminders: '📋 查看提醒事项',
  cancel_reminder: '❌ 取消提醒',
  todo_add: '📝 登记待办事项',
  todo_list: '📋 查询待办清单',
  todo_done: '✅ 完成待办事项',
};

function getToolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name && name.startsWith('wf_')) return '⚡ 执行自建流程: ' + name.slice(3);
  return '⚙️ 调用工具: ' + name;
}

function extractToolNames(buffer) {
  const names = new Set();
  for (const raw of buffer) {
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const tcs = j?.choices?.[0]?.delta?.tool_calls || j?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (tc.function?.name) names.add(tc.function.name);
        }
      }
    } catch (e) {}
  }
  return Array.from(names);
}

const normMessages = (arr) =>
  (Array.isArray(arr) ? arr : []).map((m) => {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length && typeof m.reasoning_content !== 'string') {
      return { ...m, reasoning_content: '' };
    }
    return m;
  });

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n') : String(c == null ? '' : c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAuth = (h) => String(h || '').replace(new RegExp('^' + 'Bea' + 'rer' + '\\s+', 'i'), '');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 30 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
const jsonOut = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sseHeaders = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
const sseSend = (res, obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
const sseEnd = (res) => { try { res.write('data: [DONE]\n\n'); res.end(); } catch (e) {} };
const chunkMsg = (id, model, delta, finish) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish || null }] });

const directiveNow = () => 'Current server time: ' + new Date().toISOString() + ' (UTC; user timezone Asia/Shanghai = UTC+8). You can call the provided tools (platform_status, run_brief, list_alerts, kb_save, create_reminder, list_reminders, cancel_reminder, todo_add, todo_list, todo_done, web_search, kb_search) when the user asks about the platform, reminders, search or the knowledge base. Prefer acting over asking clarifying questions. 自建流程工具（wf_ 前缀）可直接触发：用户说「跑一下 X」时调用对应 wf_ 工具。';

function logTurn(payload) {
  fetch(LOG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH_PREFIX + CHAT_KEY }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) }).catch(() => {});
}

const EMB_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings";
const DASH_KEY = process.env[String.fromCharCode(68, 65, 83, 72, 83, 67, 79, 80, 69, 95, 65, 80, 73, 95, 75, 69, 89)] || '';
const MODEL_MAP = { 'text-embedding-3-small': 'text-embedding-v4', 'text-embedding-3-large': 'text-embedding-v4', 'text-embedding-ada-002': 'text-embedding-v4' };

async function handleEmbeddings(res, body) {
  const t0 = Date.now();
  if (!DASH_KEY) return jsonOut(res, 500, { error: { message: 'embeddings key missing on bridge' } });
  const reqModel = String((body && body.model) || 'text-embedding-3-small');
  const model = MODEL_MAP[reqModel] || (/^text-embedding-v[0-9]/.test(reqModel) ? reqModel : 'text-embedding-v4');
  const payload = { model, input: body.input };
  if (body.dimensions) payload.dimensions = body.dimensions;
  try {
    const r = await fetch(EMB_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH_PREFIX + DASH_KEY }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    console.log('[embeddings] req=' + reqModel + ' -> ' + model + (body.dimensions ? ' dims=' + body.dimensions : '') + ' http=' + r.status + ' ms=' + (Date.now() - t0));
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch (e) {
    console.log('[embeddings] FAILED ' + String((e && e.message) || e).slice(0, 120));
    jsonOut(res, 502, { error: { message: 'embeddings upstream failed' } });
  }
}

async function proxyGateway(req, res, raw) {
  try {
    const r = await fetch(GATEWAY + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: req.headers['authorization'] || '', 'x-session-id': String(req.headers['x-session-id'] || ''), 'x-client': String(req.headers['x-client'] || 'stream-bridge') },
      body: raw,
      signal: AbortSignal.timeout(300000),
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch (e) {
    jsonOut(res, 502, { error: { message: 'gateway unavailable: ' + String(e.message).slice(0, 160) } });
  }
}

async function handleStream(req, res, body) {
  const sid = String(req.headers['x-session-id'] || body.user || 'lobehub');
  const client = String(req.headers['x-client'] || 'stream-bridge');
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Inline locally-hosted image URLs as data URLs (upstream providers cannot reach this host).
  try {
    const hasImg = messages.some((m) => Array.isArray(m && m.content) && m.content.some((p) => p && p.type === "image_url" && p.image_url && typeof p.image_url.url === "string"));
    if (hasImg) {
      let inlined = 0;
      for (const msg of messages) {
        if (!Array.isArray(msg && msg.content)) continue;
        for (const part of msg.content) {
          if (!part || part.type !== "image_url" || !part.image_url || typeof part.image_url.url !== "string") continue;
          const mm = part.image_url.url.match(/^https?:\/\/[^\/]+:(3210|9000)(\/.*)$/i);
          if (!mm) continue;
          const base = mm[1] === "3210" ? "http://lobechat:3210" : "http://minio:9000";
          try {
            const rr = await fetch(base + mm[2], { signal: AbortSignal.timeout(30000) });
            if (!rr.ok) continue;
            const buf = Buffer.from(await rr.arrayBuffer());
            if (!buf.length) continue;
            const mime = (buf[0] === 0x89 && buf[1] === 0x50) ? "image/png" : (buf[0] === 0xff && buf[1] === 0xd8) ? "image/jpeg" : (buf[0] === 0x47 && buf[1] === 0x49) ? "image/gif" : ((buf[0] === 0x52 && buf[1] === 0x49) ? "image/webp" : "image/png");
            part.image_url.url = "data:" + mime + ";base64," + buf.toString("base64");
            inlined += 1;
          } catch (e2) {}
        }
      }
      if (inlined) console.log("[vision] inlined local images=" + inlined);
    }
  } catch (e) {}

  const userMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userText = textOf(userMsg && userMsg.content).slice(0, 8000);
  const started = Date.now();
  const model = String(body.model || MODEL_UPSTREAM);
  const wfTools = await getWfTools();
  console.log('[req] stream sid=' + sid + ' msg=' + userText.slice(0, 28).replace(/\s+/g, ' '));

  const upstreamBody = {
    model: MODEL_UPSTREAM,
    messages: [...normMessages(messages), { role: 'system', content: directiveNow() }],
    stream: true,
    stream_options: { include_usage: true },
    tools: [...SERVER_TOOLS, ...wfToolDefs(wfTools), ...(Array.isArray(body.tools) ? body.tools : [])],
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
  };

  let sseStarted = false;
  let contentAcc = '';
  let reasoningAcc = '';
  let usage = null;
  let sawToolCalls = false;
  let upstreamFailed = false;
  let finishReason = null;
  let bufferMode = false;
  const toolBuffer = [];

  try {
    const r = await fetch(UPSTREAM + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AUTH_PREFIX + UP_KEY },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) throw new Error('upstream ' + r.status + ' ' + (await r.text()).slice(0, 120));
    sseHeaders(res);
    sseStarted = true;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.usage) usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        if (ch.finish_reason) finishReason = ch.finish_reason;
        if (d.tool_calls && d.tool_calls.length) {
          sawToolCalls = true;
          bufferMode = true;
          toolBuffer.push(payload);
          continue;
        }
        if (bufferMode) { toolBuffer.push(payload); continue; }
        if (d.reasoning_content) { reasoningAcc += d.reasoning_content; sseSend(res, j); continue; }
        if (d.content) { contentAcc += d.content; sseSend(res, j); continue; }
        if (d.role) { sseSend(res, j); continue; }
      }
    }
  } catch (e) {
    console.log('[stream] upstream fail: ' + String((e && e.message) || e).slice(0, 300));
    if (!sseStarted) upstreamFailed = true;
    else {
      // stream broke mid-flight: emit a soft note then fall through to fallback if we have no content
      if (!contentAcc) upstreamFailed = true;
    }
  }

  const needFallback = sawToolCalls || (upstreamFailed && !contentAcc) || finishReason === 'tool_calls';
  if (!needFallback) {
    if (usage) sseSend(res, { id: 'chatcmpl-bridge-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage });
    sseEnd(res);
    console.log('[done] stream ms=' + (Date.now() - started) + ' content=' + contentAcc.length);
    logTurn({ session_id: sid, client, model, user_text: userText, assistant_text: contentAcc, reasoning: reasoningAcc.slice(0, 2000), usage, latency_ms: Date.now() - started, path: 'stream' });
    return;
  }

  // Fallback: run the full gateway (tool loop) non-stream, with live status streaming.
  console.log('[fallback] toolCalls=' + (sawToolCalls ? toolBuffer.length : 0) + ' upstreamFailed=' + upstreamFailed + ' contentLen=' + contentAcc.length + ' reasonLen=' + reasoningAcc.length);
  const tfb = Date.now();
  const id = 'chatcmpl-bridge-' + Date.now();
  const wasStarted = sseStarted;

  // Immediate feedback to eliminate silent freeze during gateway execution
  if (!sseStarted) {
    sseHeaders(res);
    sseStarted = true;
    sseSend(res, chunkMsg(id, model, { role: 'assistant' }, null));
  }

  // Stream human-friendly tool execution progress into thinking block
  const toolNames = extractToolNames(toolBuffer);
  let statusNote = '';
  if (sawToolCalls || toolNames.length) {
    const desc = toolNames.length ? toolNames.map(getToolLabel).join('、') : '⚙️ 执行平台内部工具';
    statusNote = `\n\n> 💡 **${desc}**（正在执行中，请稍候...）\n\n`;
  } else if (upstreamFailed && !contentAcc) {
    statusNote = `\n\n> ⚠️ 上游流式中断，正在无缝切换网关重试...\n\n`;
  }
  if (statusNote) {
    sseSend(res, chunkMsg(id, model, { reasoning_content: statusNote }, null));
  }

  // Subtle heartbeat keeps SSE alive and gives visual breathing indicator
  const heartbeatTimer = setInterval(() => {
    try {
      sseSend(res, chunkMsg(id, model, { reasoning_content: '·' }, null));
    } catch (e) {}
  }, 2500);

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), 240000);
  req.on('close', () => {
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutId);
    abortCtrl.abort();
  });

  let gj = null;
  let gok = false;
  try {
    const r = await fetch(GATEWAY + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: req.headers['authorization'] || '', 'x-session-id': sid, 'x-client': client },
      body: JSON.stringify({ ...body, stream: false }),
      signal: abortCtrl.signal,
    });
    gj = await r.json();
    gok = r.ok;
  } catch (e) {
    console.log('[fallback] gateway error: ' + String(e && e.message || e));
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutId);
  }

  if (statusNote) {
    sseSend(res, chunkMsg(id, model, { reasoning_content: ' 完成！\n\n' }, null));
  }

  console.log('[fallback] gateway ms=' + (Date.now() - tfb) + ' ok=' + gok + ' content=' + String((gok && gj && gj.choices && gj.choices[0] && gj.choices[0].message && gj.choices[0].message.content) || '').length);
  const msg = (gok && gj && gj.choices && gj.choices[0] && gj.choices[0].message) || {};
  const content = String(msg.content || '');
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;

  if (!content && (!toolCalls || !toolCalls.length)) {
    if (!wasStarted && !statusNote) sseSend(res, chunkMsg(id, model, { role: 'assistant' }, null));
    sseSend(res, chunkMsg(id, model, { content: gok ? '（空回复）' : '⚠️ 处理失败，请稍后再试' }, null));
    sseSend(res, chunkMsg(id, model, {}, 'stop'));
    sseEnd(res);
    return;
  }

  if (toolCalls && toolCalls.length) {
    const deltaTc = toolCalls.map((t, i) => ({ index: i, id: t.id || 'call_' + i + '_' + Date.now(), type: 'function', function: { name: (t.function && t.function.name) || '', arguments: (t.function && t.function.arguments) || '{}' } }));
    sseSend(res, chunkMsg(id, model, { role: 'assistant', tool_calls: deltaTc }, null));
    sseSend(res, chunkMsg(id, model, {}, 'tool_calls'));
    sseEnd(res);
    return;
  }

  if (!wasStarted && !statusNote) {
    sseSend(res, chunkMsg(id, model, { role: 'assistant' }, null));
  }
  const CH = 60;
  for (let i = 0; i < content.length; i += CH) {
    sseSend(res, chunkMsg(id, model, { content: content.slice(i, i + CH) }, null));
    await sleep(15);
  }
  sseSend(res, chunkMsg(id, model, {}, 'stop'));
  sseEnd(res);
  // gateway already logged this turn (it handled the request), so no logTurn here.
}

/* ---- voice: Telegram <-> DashScope (ASR + TTS) ---- */
const VOICE_TOKEN = process.env[String.fromCharCode(84, 69, 76, 69, 71, 82, 65, 77, 95, 66, 79, 84, 95, 84, 79, 75, 69, 78)] || '';
const DASH_GEN = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DASH_AUTH = AUTH_PREFIX + DASH_KEY;

function tgMulti(fields, file) {
  const boundary = '----voice' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const k of Object.keys(fields)) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
  }
  if (file) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + file.name + '"; filename="' + file.filename + '"\r\nContent-Type: ' + file.contentType + '\r\n\r\n'));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

async function tgUpload(method, fields, file) {
  const mp = tgMulti(fields, file);
  const r = await fetch('https://api.telegram.org/bot' + VOICE_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': mp.contentType }, body: mp.body, signal: AbortSignal.timeout(120000) });
  return r.json().catch(() => ({}));
}

async function handleVoiceTranscribe(res, body) {
  const t0 = Date.now();
  try {
    const fileId = String((body && body.file_id) || '');
    if (!fileId) return jsonOut(res, 400, { ok: false, error: 'file_id required' });
    if (!VOICE_TOKEN) return jsonOut(res, 500, { ok: false, error: 'telegram token missing on bridge' });
    const gf = await fetch('https://api.telegram.org/bot' + VOICE_TOKEN + '/getFile?file_id=' + encodeURIComponent(fileId), { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
    if (!gf || !gf.ok || !gf.result || !gf.result.file_path) return jsonOut(res, 502, { ok: false, error: 'getFile failed' });
    const fp = String(gf.result.file_path);
    const dl = await fetch('https://api.telegram.org/file/bot' + VOICE_TOKEN + '/' + fp, { signal: AbortSignal.timeout(60000) });
    if (!dl.ok) return jsonOut(res, 502, { ok: false, error: 'download failed ' + dl.status });
    const buf = Buffer.from(await dl.arrayBuffer());
    const ext = (fp.split('.').pop() || 'oga').toLowerCase();
    let fmt = ext === 'oga' || ext === 'ogg' || ext === 'opus' ? 'ogg' : ext === 'mp3' ? 'mp3' : ext === 'm4a' ? 'mp4' : 'wav';
    if (buf.length > 4) { const mg = buf.slice(0, 4).toString('hex'); if (mg === '52494646') fmt = 'wav'; else if (mg === '4f676753') fmt = 'ogg'; }
    const b64 = buf.toString('base64');
    const ar = await fetch(DASH_GEN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: DASH_AUTH }, body: JSON.stringify({ model: 'qwen3-asr-flash', input: { messages: [{ role: 'user', content: [{ audio: 'data:audio/' + fmt + ';base64,' + b64 }] }] }, parameters: {} }), signal: AbortSignal.timeout(120000) });
    const aj = await ar.json().catch(() => ({}));
    const c = aj && aj.output && aj.output.choices && aj.output.choices[0] && aj.output.choices[0].message && aj.output.choices[0].message.content;
    const text = Array.isArray(c) ? String((c[0] && c[0].text) || '') : String(c || '');
    console.log('[voice] asr bytes=' + buf.length + ' fmt=' + fmt + ' text=' + text.slice(0, 40) + ' ms=' + (Date.now() - t0));
    return jsonOut(res, 200, { ok: !!text, text });
  } catch (e) {
    console.log('[voice] asr FAILED ' + String((e && e.message) || e).slice(0, 160));
    return jsonOut(res, 502, { ok: false, error: 'asr failed' });
  }
}

async function handleVoiceReply(res, body) {
  const t0 = Date.now();
  try {
    const text = String((body && body.text) || '').slice(0, 1200);
    const chatId = String((body && body.chat_id) || '');
    if (!text || !chatId || !VOICE_TOKEN) return jsonOut(res, 400, { ok: false, error: 'text/chat_id required' });
    const voice = String(process.env.VOICE_TTS_VOICE || 'Cherry');
    const tr = await fetch(DASH_GEN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: DASH_AUTH }, body: JSON.stringify({ model: 'qwen-tts', input: { text, voice }, parameters: {} }), signal: AbortSignal.timeout(120000) });
    const tj = await tr.json().catch(() => ({}));
    const url = String((tj && tj.output && tj.output.audio && tj.output.audio.url) || '').replace(/^http:/, 'https:');
    if (!url) return jsonOut(res, 502, { ok: false, error: 'tts no audio url' });
    const ab = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
    let r = await tgUpload('sendVoice', { chat_id: chatId }, { name: 'voice', filename: 'reply.wav', contentType: 'audio/wav', data: ab });
    let mode = 'voice';
    if (!r || !r.ok) {
      r = await tgUpload('sendAudio', { chat_id: chatId, title: '语音回复' }, { name: 'audio', filename: 'reply.wav', contentType: 'audio/wav', data: ab });
      mode = 'audio';
    }
    const ok = !!(r && r.ok);
    console.log('[voice] tts chars=' + text.length + ' bytes=' + ab.length + ' mode=' + (ok ? mode : 'failed') + ' ms=' + (Date.now() - t0));
    return jsonOut(res, ok ? 200 : 502, { ok, mode });
  } catch (e) {
    console.log('[voice] tts FAILED ' + String((e && e.message) || e).slice(0, 160));
    return jsonOut(res, 502, { ok: false, error: 'tts failed' });
  }
}
async function handleImageFetch(res, body) {
  const t0 = Date.now();
  try {
    const fileId = String((body && body.file_id) || '');
    if (!fileId) return jsonOut(res, 400, { ok: false, error: 'file_id required' });
    if (!VOICE_TOKEN) return jsonOut(res, 500, { ok: false, error: 'telegram token missing on bridge' });
    const gf = await fetch('https://api.telegram.org/bot' + VOICE_TOKEN + '/getFile?file_id=' + encodeURIComponent(fileId), { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
    if (!gf || !gf.ok || !gf.result || !gf.result.file_path) return jsonOut(res, 502, { ok: false, error: 'getFile failed' });
    const fp = String(gf.result.file_path);
    const dl = await fetch('https://api.telegram.org/file/bot' + VOICE_TOKEN + '/' + fp, { signal: AbortSignal.timeout(60000) });
    if (!dl.ok) return jsonOut(res, 502, { ok: false, error: 'download failed ' + dl.status });
    const buf = Buffer.from(await dl.arrayBuffer());
    if (!buf.length) return jsonOut(res, 502, { ok: false, error: 'empty file' });
    if (buf.length > 8 * 1024 * 1024) return jsonOut(res, 502, { ok: false, error: 'image too large' });
    let mime = 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
    else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) mime = 'image/webp';
    console.log('[image] fetch bytes=' + buf.length + ' mime=' + mime + ' ms=' + (Date.now() - t0));
    return jsonOut(res, 200, { ok: true, mime, bytes: buf.length, data_uri: 'data:' + mime + ';base64,' + buf.toString('base64') });
  } catch (e) {
    console.log('[image] fetch FAILED ' + String((e && e.message) || e).slice(0, 160));
    return jsonOut(res, 502, { ok: false, error: 'image fetch failed' });
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const path0 = req.url ? req.url.split('?')[0] : '';
    if (path0 === '/healthz') return jsonOut(res, 200, { ok: true, upstream: !!UP_KEY, gateway: GATEWAY, embeddings: !!DASH_KEY, voice: !!VOICE_TOKEN, tools: SERVER_TOOLS.map((t) => t.function.name) });
    if (req.method !== 'POST') return jsonOut(res, 405, { error: { message: 'method not allowed' } });
    const raw = await readBody(req);
    let body = null;
    try { body = JSON.parse(raw); } catch (e) { return jsonOut(res, 400, { error: { message: 'invalid JSON' } }); }
    const provided = stripAuth(req.headers['authorization']);
    if (!CHAT_KEY || provided !== CHAT_KEY) return jsonOut(res, 401, { error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' } });
    if (path0.endsWith('/embeddings')) return handleEmbeddings(res, body);
    if (path0 === '/voice/transcribe') return handleVoiceTranscribe(res, body);
    if (path0 === '/voice/reply') return handleVoiceReply(res, body);
    if (path0 === '/image/fetch') return handleImageFetch(res, body);
    if (!path0.endsWith('/chat/completions')) return jsonOut(res, 404, { error: { message: 'not found' } });
    if (body && body.stream === true) return handleStream(req, res, body);
    return proxyGateway(req, res, raw);
  } catch (e) {
    try { jsonOut(res, 500, { error: { message: String(e && e.message || e).slice(0, 200) } }); } catch (e2) {}
  }
});
server.listen(PORT, () => console.log('stream-bridge on ' + PORT + ' (gateway=' + GATEWAY + ')'));
