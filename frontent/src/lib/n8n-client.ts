const N8N_URL = process.env.NEXT_PUBLIC_N8N_URL || 'http://localhost:5678';
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
