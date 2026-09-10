import type { ChatStats } from '@/lib/n8n-client';

/** 统一后的执行行：stats 与原始 executions 降级路径共用同一形状 */
export interface ExecRow {
  id: string;
  /** 执行结束时间（ISO），可能是 stoppedAt / finishedAt / startedAt / createdAt */
  endedAt: string | null;
  status: string;
  model: string | null;
  client: string | null;
  sessionId: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** n8n 公共 API 的原始执行（降级路径用） */
export interface RawExecution {
  id: string;
  workflowId?: string;
  status?: string;
  mode?: string;
  stoppedAt?: string | null;
  finishedAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
}

/**
 * n8n 执行的结束时间字段因版本而异（公共 API 只给 stoppedAt，
 * stats 给 created_at）——统一按优先级取第一个存在的值。
 */
export function executionEndedAt(e: {
  stoppedAt?: string | null;
  finishedAt?: string | null;
  startedAt?: string | null;
  createdAt?: string | null;
}): string | null {
  return e.stoppedAt ?? e.finishedAt ?? e.startedAt ?? e.createdAt ?? null;
}

export function statsRowToExecRow(r: ChatStats['recent'][number]): ExecRow {
  return {
    id: r.execution_id,
    endedAt: r.created_at ?? null,
    status: r.status,
    model: r.model || null,
    client: r.client || null,
    sessionId: r.session_id || null,
    latencyMs: r.latency_ms ?? null,
    totalTokens: r.total_tokens ?? null,
    promptTokens: r.prompt_tokens ?? null,
    completionTokens: r.completion_tokens ?? null,
    errorCode: r.error_code || null,
    errorMessage: r.error_message || null
  };
}

export function rawExecToExecRow(e: RawExecution): ExecRow {
  return {
    id: String(e.id),
    endedAt: executionEndedAt(e),
    status: e.status ?? 'unknown',
    model: null,
    client: null,
    sessionId: null,
    latencyMs: null,
    totalTokens: null,
    promptTokens: null,
    completionTokens: null,
    errorCode: e.status === 'error' ? 'unknown_error' : null,
    errorMessage: e.status === 'error' ? '详情请在 n8n 编辑器中查看该执行' : null
  };
}

/** 相对时间：3 分钟前 / 2 小时前 / 5 天前；无效输入返回 null */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 延迟颜色阈值：>8s 红，>3s 琥珀，其余默认 */
export function latencyClass(ms: number | null): string {
  if (ms === null) return 'text-zinc-400';
  if (ms > 8000) return 'text-red-400';
  if (ms > 3000) return 'text-amber-400';
  return 'text-zinc-200';
}

/** 客户端来源的展示色；unknown 灰色 */
export function clientColor(client: string | null): string {
  switch (client) {
    case 'lobechat':
      return '#3B82F6';
    case 'curl':
    case 'curl-test':
      return '#06B6D4';
    default:
      return '#6B7280';
  }
}

export type TimeRange = 'all' | '1h' | '24h' | '7d';

const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000
};

export function inTimeRange(iso: string | null, range: TimeRange): boolean {
  if (range === 'all') return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= RANGE_MS[range];
}
