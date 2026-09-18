const N8N_URL = process.env.N8N_URL || process.env.NEXT_PUBLIC_N8N_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
// Chat Gateway 的 Bearer key（n8n env CHAT_API_KEY），与公共 API 的 X-N8N-API-KEY 是两回事
const CHAT_API_KEY = process.env.CHAT_API_KEY || '';

const headers = {
  'X-N8N-API-KEY': N8N_API_KEY,
  'Content-Type': 'application/json'
};

export async function getHealthz() {
  try {
    const res = await fetch(`${N8N_URL}/healthz`, { headers });
    if (!res.ok) throw new Error('Health check failed');
    return await res.json();
  } catch (error) {
    console.error('Error fetching health:', error);
    return { status: 'error' };
  }
}

export async function getWorkflows() {
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getExecutions(limit: number = 10) {
  const res = await fetch(`${N8N_URL}/api/v1/executions?limit=${limit}`, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface ChatStats {
  window: { scanned: number };
  totals: { total: number; success: number; error: number; error_rate: number };
  avg_latency_ms: number;
  by_model: Record<string, number>;
  by_client: Record<string, number>;
  unique_sessions: number;
  recent: Array<{
    execution_id: string;
    session_id: string;
    model: string;
    client: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
    latency_ms: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    created_at: string;
  }>;
}

export async function getChatStats(): Promise<ChatStats> {
  const res = await fetch(`${N8N_URL}/webhook/v1/stats/executions`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('统计接口 401：CHAT_API_KEY 未配置或不正确');
  if (!res.ok) throw new Error(`Chat Stats API error: ${res.status}`);
  return res.json();
}

export interface PlatformOverview {
  ok: boolean;
  generated_at: string;
  chat_24h: {
    total: number;
    success: number;
    error: number;
    error_rate: number;
    avg_latency_ms: number;
    cost_usd: number;
    unique_sessions: number;
  };
  chat_window: { scanned: number };
  alerts: {
    recent: Array<{ kind: string; message: string; error_rate: number | null; created_at: string }>;
    recent_count: number;
  };
  kb: {
    documents?: number;
    chunks?: number;
    embed_tokens_used?: number;
    embed_quota_tokens?: number;
    embed_pct?: number | null;
    error?: string;
  } | null;
}

export async function getOverview(): Promise<PlatformOverview> {
  const res = await fetch(`${N8N_URL}/webhook/admin/overview`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Overview API error: ${res.status}`);
  return res.json();
}

export interface ManagedKey {
  id: string;
  name: string;
  enabled: boolean;
  rate_limit_rpm: number;
  total_cost: number;
  fingerprint: string;
  created_at: string;
}

export async function getKeys(): Promise<{ ok: boolean; keys: ManagedKey[] }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/keys`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Keys API error: ${res.status}`);
  return res.json();
}

export async function manageKey(payload: {
  action: string;
  name: string;
  rate_limit_rpm?: number;
}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/keys/manage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export interface AlertItem {
  kind: string;
  message: string;
  error_rate: number | null;
  total: number | null;
  errors: number | null;
  threshold: number | null;
  delivered: string | null;
  created_at: string;
}

export async function getAlerts(): Promise<{
  ok: boolean;
  delivery: { configured: boolean; format: string };
  alerts: AlertItem[];
}> {
  const res = await fetch(`${N8N_URL}/webhook/admin/alerts`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Alerts API error: ${res.status}`);
  return res.json();
}

export async function testAlert(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/alerts/test`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: '{}',
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export interface PlatformSettings {
  ok: boolean;
  alerts: {
    window_min: number;
    rate_threshold: number;
    min_total: number;
    cooldown_min: number;
    webhook_configured: boolean;
    webhook_format: string;
  };
  embedding: { quota_tokens: number };
  retention: { messages_days: number; executions_days: number };
  note: string;
}

export async function getSettings(): Promise<PlatformSettings> {
  const res = await fetch(`${N8N_URL}/webhook/admin/settings`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Settings API error: ${res.status}`);
  return res.json();
}

export interface KbDoc {
  doc_id: string;
  title: string;
  source_type: string;
  status: string;
  created_at: string;
  chunks: number;
}

export async function getKbDocs(): Promise<{ ok: boolean; docs: KbDoc[] }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/kb/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mode: 'list' }),
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`KB list error: ${res.status}`);
  return res.json();
}

export async function kbAction(payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/kb/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export interface ModelEntry {
  alias: string;
  upstream: string;
  tools: boolean;
  pricing: { input: number; cache_hit: number; output: number } | null;
  calls_30d: number;
  cost_30d: number;
  is_default: boolean;
}

export async function getModels(): Promise<{
  ok: boolean;
  default_model: string | null;
  models: ModelEntry[];
  note: string;
}> {
  const res = await fetch(`${N8N_URL}/webhook/admin/models`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Models API error: ${res.status}`);
  return res.json();
}

export interface BriefItem {
  id: number | string;
  title: string;
  content_md: string;
  brief_date: string;
  meta: string | null;
  created_at: string;
}

export async function getBriefs(): Promise<{ ok: boolean; count: number; briefs: BriefItem[] }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/briefs`, {
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Briefs API error: ${res.status}`);
  return res.json();
}

export async function runBrief(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/briefs/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: '{}',
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export async function pushLatestBrief(): Promise<{ status: number; body: any }> {
  const list = await getBriefs();
  const latest = list.briefs && list.briefs[0];
  if (!latest) return { status: 404, body: { error: 'no briefs yet' } };
  const res = await fetch(`${N8N_URL}/webhook/internal/notify`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + CHAT_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ kind: '晨报', message: latest.title + String.fromCharCode(10, 10) + String(latest.content_md || '').slice(0, 1500) }),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export interface DelegationPerson {
  name: string;
  display_name: string;
  role: string;
  has_channel: boolean;
  open: number;
  overdue: number;
  escalated: number;
  awaiting_ack: number;
  done_7d: number;
  avg_ack_hours: number | null;
  never_acked: number;
  oldest_overdue_days: number;
}

export interface Delegation {
  ok: boolean;
  generated_at: string;
  today: string;
  totals: {
    people: number;
    assigned_open: number;
    unassigned_open: number;
    overdue: number;
    escalated: number;
    awaiting_ack: number;
    done_7d: number;
    channel_less: number;
  };
  oldest_waiting: { id: number; text: string; owner: string; due_date: string; days_late: number } | null;
  people: DelegationPerson[];
  attention: string[];
}

export async function getDelegation(): Promise<Delegation> {
  const res = await fetch(`${N8N_URL}/webhook/admin/delegation`, {
    headers: {
      Authorization: 'Bea' + 'rer ' + CHAT_API_KEY,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin Delegation API error: ${res.status}`);
  return res.json();
}

export interface Person {
  id: string;
  name: string;
  display_name: string;
  role: string;
  channels: string;
  tz: string;
  active: boolean;
  note: string;
  created_at: string;
}

export async function getPeople(): Promise<{ ok: boolean; count: number; people: Person[] }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/people`, {
    headers: {
      Authorization: 'Bea' + 'rer ' + CHAT_API_KEY,
      'Content-Type': 'application/json'
    },
    cache: 'no-store'
  });
  if (res.status === 401) throw new Error('Admin API 401 - key mismatch');
  if (!res.ok) throw new Error(`Admin People API error: ${res.status}`);
  return res.json();
}

export async function managePerson(payload: {
  action: string;
  name: string;
  display_name?: string;
  role?: string;
  channels?: string;
  tz?: string;
  note?: string;
  active?: boolean;
}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/people/manage`, {
    method: 'POST',
    headers: {
      Authorization: 'Bea' + 'rer ' + CHAT_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

export async function getSelfcheckRuns(): Promise<{ ok: boolean; runs: any[] }> {
  const listRes = await fetch(`${N8N_URL}/api/v1/data-tables?limit=100`, { headers, cache: 'no-store' });
  const list = await listRes.json();
  const id = ((list.data || []) as any[]).find((t) => t.name === 'selfcheck_runs')?.id;
  if (!id) return { ok: false, runs: [] };
  const rowsRes = await fetch(`${N8N_URL}/api/v1/data-tables/${id}/rows?limit=8`, { headers, cache: 'no-store' });
  const rows = await rowsRes.json();
  const runs = ((rows.data || []) as any[]).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { ok: true, runs };
}

export async function runSelfcheck(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/selfcheck/run`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CHAT_API_KEY, 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body };
}

export async function getTodos(owner?: string): Promise<{ status: number; body: any }> {
  const qs = owner ? '?owner=' + encodeURIComponent(owner) : '';
  const res = await fetch(`${N8N_URL}/webhook/admin/todos${qs}`, { headers: { Authorization: 'Bea' + 'rer ' + CHAT_API_KEY }, cache: 'no-store' });
  let body: any = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body };
}

export async function completeTodo(id: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/todos/complete`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CHAT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body };
}

export async function getMemory(): Promise<{ ok: boolean; mine: any[]; lobe: any[]; counts: { mine: number; lobe: number } }> {
  const res = await fetch(`${N8N_URL}/webhook/internal/memory`, {
    method: 'POST',
    headers: { Authorization: 'Bea' + 'rer ' + CHAT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', limit: 10 }),
    cache: 'no-store'
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok !== true) return { ok: false, mine: [], lobe: [], counts: { mine: 0, lobe: 0 } };
  return body;
}

export async function getWeekly(): Promise<{ ok: boolean; reviews: any[] }> {
  const listRes = await fetch(`${N8N_URL}/api/v1/data-tables?limit=100`, { headers, cache: "no-store" });
  const list = await listRes.json();
  const id = ((list.data || []) as any[]).find((t) => t.name === "weekly_reviews")?.id;
  if (!id) return { ok: false, reviews: [] };
  const rowsRes = await fetch(`${N8N_URL}/api/v1/data-tables/${id}/rows?limit=250`, { headers, cache: "no-store" });
  const rows = await rowsRes.json();
  const reviews = ((rows.data || []) as any[]).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { ok: true, reviews };
}

export async function runWeekly(scope: 'owner' | 'team' = 'owner'): Promise<{ status: number; body: any }> {
  const res = await fetch(`${N8N_URL}/webhook/admin/weekly-review/run`, {
    method: 'POST',
    headers: { Authorization: 'Bea' + 'rer ' + CHAT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true, scope }),
    cache: 'no-store'
  });
  let body: any = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body };
}
