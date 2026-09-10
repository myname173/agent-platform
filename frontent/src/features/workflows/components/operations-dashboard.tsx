'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChatStats } from '@/lib/n8n-client';
import { cn } from '@/lib/utils';
import {
  clientColor,
  executionEndedAt,
  formatDateTime,
  formatMs,
  formatTokens,
  inTimeRange,
  latencyClass,
  rawExecToExecRow,
  relativeTime,
  statsRowToExecRow,
  type ExecRow,
  type RawExecution,
  type TimeRange
} from '../lib/stats-utils';

/* ------------------------------------------------------------------ */
/* 调色板（深色指挥台）                                                  */
/* ------------------------------------------------------------------ */
const C = {
  bg: '#0B1220',
  card: '#111827',
  border: '#1F2937',
  primary: '#3B82F6',
  accent: '#06B6D4',
  ok: '#10B981',
  danger: '#EF4444',
  warn: '#F59E0B'
};

type WorkflowSummary = {
  id: string;
  name: string;
  active: boolean;
  nodes: unknown[];
};

type StatusFilter = 'all' | 'success' | 'error';

/* ------------------------------------------------------------------ */
/* 小组件：计数动画 / 环形成功率 / 健康灯                                */
/* ------------------------------------------------------------------ */

function CountUp({
  value,
  format
}: {
  value: number | null;
  format?: (n: number) => string;
}) {
  const target = value ?? 0;
  const [display, setDisplay] = React.useState(target);
  const prev = React.useRef(target);

  React.useEffect(() => {
    const from = prev.current;
    const to = target;
    if (from === to) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 500);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return <span className="tabular-nums">{format ? format(display) : display}</span>;
}

function RateRing({ rate }: { rate: number | null }) {
  if (rate === null) {
    return <div className="text-3xl font-semibold text-zinc-500">—</div>;
  }
  const pct = Math.round(rate * 100);
  const color = pct >= 95 ? C.ok : pct >= 90 ? C.warn : C.danger;
  const r = 26;
  const circ = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#1F2937" strokeWidth="6" />
        <motion.circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={false}
          animate={{ strokeDashoffset: circ * (1 - rate) }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </svg>
      <div>
        <div className="text-3xl font-semibold tabular-nums" style={{ color }}>
          <CountUp value={pct} format={(n) => `${n}%`} />
        </div>
      </div>
    </div>
  );
}

function HealthPill({ status }: { status: string | null }) {
  const ok = status === 'ok';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
        ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-red-500/30 bg-red-500/10 text-red-400'
      )}
    >
      <span className="relative flex h-2 w-2">
        {ok && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: ok ? C.ok : C.danger }}
        />
      </span>
      {ok ? '引擎正常' : status === null ? '引擎状态未知' : '引擎异常'}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件：KPI 卡                                                       */
/* ------------------------------------------------------------------ */

function KpiCard({
  label,
  onClick,
  active,
  children,
  hint
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        'group w-full rounded-xl border p-4 text-left transition-colors',
        active ? 'border-[#3B82F6] bg-[#0F1B33]' : 'border-[#1F2937] bg-[#111827] hover:border-[#3B82F6]/60'
      )}
      style={{ backgroundColor: active ? undefined : C.card }}
    >
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium tracking-wide text-zinc-400">{label}</span>
        {hint ? <span className="text-[10px] text-zinc-500">{hint}</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/* 小组件：分布条（可点击筛选）                                          */
/* ------------------------------------------------------------------ */

function DistributionBars({
  title,
  counts,
  selected,
  onSelect,
  colorFor
}: {
  title: string;
  counts: Array<[string, number]>;
  selected: string;
  onSelect: (key: string) => void;
  colorFor: (key: string) => string;
}) {
  const max = Math.max(1, ...counts.map(([, n]) => n));
  return (
    <div className="rounded-xl border border-[#1F2937] bg-[#111827] p-4">
      <div className="mb-3 text-xs font-medium tracking-wide text-zinc-400">{title}</div>
      {counts.length === 0 ? (
        <div className="py-4 text-center text-xs text-zinc-500">暂无数据</div>
      ) : (
        <div className="space-y-2">
          {counts.map(([key, n]) => {
            const isSelected = selected === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(key)}
                title={key === 'unknown' ? '客户端未声明 X-Client' : undefined}
                className={cn(
                  'block w-full rounded-md px-2 py-1.5 text-left transition-all',
                  isSelected ? 'ring-1 ring-[#3B82F6] bg-[#0F1B33]' : 'hover:bg-white/5'
                )}
              >
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className={cn('font-mono', key === 'unknown' ? 'text-zinc-500' : 'text-zinc-200')}>
                    {key}
                  </span>
                  <span className="tabular-nums text-zinc-400">{n}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#1F2937]">
                  <motion.div
                    initial={false}
                    animate={{ width: `${(n / max) * 100}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                    className="h-full rounded-full"
                    style={{ background: key === 'unknown' ? '#6B7280' : colorFor(key) }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 趋势图自定义 tooltip                                                  */
/* ------------------------------------------------------------------ */

function TrendTip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-[#1F2937] bg-[#0B1220] px-3 py-2 text-xs shadow-xl">
      <div className="text-zinc-400">{formatDateTime(p.iso)}</div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: p.status === 'success' ? C.ok : C.danger }}
        />
        <span className="text-zinc-200">{p.status}</span>
        <span className="text-zinc-400">·</span>
        <span className="text-cyan-400">{formatMs(p.latency)}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{p.model ?? '—'}</div>
    </div>
  );
}

type TrendPoint = {
  iso: string | null;
  status: string;
  latency: number | null;
  model: string | null;
  label: string;
};

/* ------------------------------------------------------------------ */
/* 主组件                                                               */
/* ------------------------------------------------------------------ */

export default function OperationsDashboard() {
  /* ---------------- 数据状态 ---------------- */
  const [stats, setStats] = React.useState<ChatStats | null>(null);
  const [statsError, setStatsError] = React.useState<string | null>(null);
  const [rawExecs, setRawExecs] = React.useState<RawExecution[]>([]);
  const [health, setHealth] = React.useState<{ status?: string } | null>(null);
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<number | null>(null);

  /* ---------------- 交互状态 ---------------- */
  const [timeRange, setTimeRange] = React.useState<TimeRange>('all');
  const [sessionOnly, setSessionOnly] = React.useState(false);
  const [sortByLatency, setSortByLatency] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const tableRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  /* ---------------- URL 同步筛选 ---------------- */
  const [statusF, setStatusF] = useQueryState(
    'status',
    parseAsStringEnum(['all', 'success', 'error'] as const).withDefault('all')
  );
  const [modelF, setModelF] = useQueryState('model', parseAsString.withDefault(''));
  const [clientF, setClientF] = useQueryState('client', parseAsString.withDefault(''));
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));

  /* ---------------- 加载 ---------------- */
  const load = React.useCallback(async () => {
    setRefreshing(true);
    const next: { stats: ChatStats | null; statsError: string | null; raw: RawExecution[] } = {
      stats: null,
      statsError: null,
      raw: []
    };
    const [healthRes, workflowsRes, statsRes] = await Promise.allSettled([
      fetch('/api/n8n/health', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/n8n/workflows', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/n8n/stats', { cache: 'no-store' }).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          const e = new Error(body?.error || `HTTP ${r.status}`) as Error & { status?: number };
          e.status = r.status;
          throw e;
        }
        return body as ChatStats;
      })
    ]);

    if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
    else setHealth({ status: 'error' });

    if (workflowsRes.status === 'fulfilled') setWorkflows(workflowsRes.value?.data || []);
    else setWorkflows([]);

    if (statsRes.status === 'fulfilled') {
      next.stats = statsRes.value;
      next.statsError = null;
    } else {
      const err = statsRes.reason as Error & { status?: number };
      next.statsError =
        err?.status === 401
          ? '统计接口 401：CHAT_API_KEY 未配置或不正确'
          : `统计暂不可用（${err?.message || '网络错误'}），已回退到原始执行列表`;
      // 降级：拉原始 executions（时间列用 stoppedAt 兜底链）
      try {
        const r = await fetch('/api/n8n/executions?limit=20', { cache: 'no-store' });
        const body = await r.json();
        next.raw = (body?.data || []) as RawExecution[];
      } catch {
        next.raw = [];
      }
    }

    setStats(next.stats);
    setStatsError(next.statsError);
    setRawExecs(next.raw);
    setLoading(false);
    setRefreshing(false);
    setLastUpdated(Date.now());
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  /* ---------------- 键盘：/ 聚焦搜索，Esc 清筛选 ---------------- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') {
        if (inInput) (target as HTMLElement).blur();
        void clearFilters();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 派生数据 ---------------- */
  const rows: ExecRow[] = React.useMemo(() => {
    if (stats) return stats.recent.map(statsRowToExecRow);
    return rawExecs.map(rawExecToExecRow);
  }, [stats, rawExecs]);

  const timeRanged = React.useMemo(
    () => rows.filter((r) => inTimeRange(r.endedAt, timeRange)),
    [rows, timeRange]
  );

  const kpi = React.useMemo(() => {
    const total = timeRanged.length;
    const success = timeRanged.filter((r) => r.status === 'success');
    const failed = total - success.length;
    const latencies = success.map((r) => r.latencyMs).filter((n): n is number => n !== null);
    const avg = latencies.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : null;
    const sessions = new Set(timeRanged.map((r) => r.sessionId).filter(Boolean));
    return {
      total,
      success: success.length,
      failed,
      rate: total ? success.length / total : null,
      avgLatency: avg,
      uniqueSessions: sessions.size
    };
  }, [timeRanged]);

  const modelCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of timeRanged) {
      const key = r.model || 'unknown';
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [timeRanged]);

  const clientCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of timeRanged) {
      const key = r.client || 'unknown';
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [timeRanged]);

  const filtered = React.useMemo(() => {
    let out = timeRanged;
    if (statusF !== 'all') out = out.filter((r) => r.status === statusF);
    if (modelF) out = out.filter((r) => (r.model || 'unknown') === modelF);
    if (clientF) out = out.filter((r) => (r.client || 'unknown') === clientF);
    if (sessionOnly) out = out.filter((r) => Boolean(r.sessionId));
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter(
        (r) =>
          (r.sessionId || '').toLowerCase().includes(needle) ||
          (r.id || '').toLowerCase().includes(needle)
      );
    }
    if (sortByLatency) {
      out = [...out].sort((a, b) => (b.latencyMs ?? -1) - (a.latencyMs ?? -1));
    }
    return out;
  }, [timeRanged, statusF, modelF, clientF, sessionOnly, q, sortByLatency]);

  const trendData: TrendPoint[] = React.useMemo(
    () =>
      timeRanged
        .slice()
        .reverse()
        .map((r, i) => ({
          iso: r.endedAt,
          status: r.status,
          latency: r.latencyMs,
          model: r.model,
          label: `#${i + 1}`
        })),
    [timeRanged]
  );

  /* ---------------- 动作 ---------------- */
  const clearFilters = React.useCallback(() => {
    void setStatusF('all');
    void setModelF('');
    void setClientF('');
    void setQ('');
    setSessionOnly(false);
    setSortByLatency(false);
  }, [setStatusF, setModelF, setClientF, setQ]);

  const activeFilterChips = React.useMemo(() => {
    const chips: Array<{ label: string; clear: () => void }> = [];
    if (statusF !== 'all')
      chips.push({
        label: `状态：${statusF === 'success' ? '成功' : '失败'}`,
        clear: () => void setStatusF('all')
      });
    if (modelF) chips.push({ label: `模型：${modelF}`, clear: () => void setModelF('') });
    if (clientF) chips.push({ label: `来源：${clientF}`, clear: () => void setClientF('') });
    if (sessionOnly)
      chips.push({ label: '仅看有 Session', clear: () => setSessionOnly(false) });
    if (q) chips.push({ label: `搜索：${q}`, clear: () => void setQ('') });
    return chips;
  }, [statusF, modelF, clientF, sessionOnly, q, setStatusF, setModelF, setClientF, setQ]);

  const copyText = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）时静默 */
    }
  }, []);

  /* ---------------- 渲染 ---------------- */

  const hasAnyFilter = activeFilterChips.length > 0;

  return (
    
      <div
        className="relative overflow-hidden rounded-2xl border border-[#1F2937] p-4 text-zinc-100 md:p-6"
        style={{ backgroundColor: C.bg }}
      >
        {/* 刷新进度条 */}
        <AnimatePresence>
          {refreshing && (
            <motion.div
              key="progress"
              initial={{ x: '-100%' }}
              animate={{ x: '100%' }}
              exit={{ opacity: 0 }}
              transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              className="absolute inset-x-0 top-0 h-0.5"
              style={{ background: `linear-gradient(90deg, transparent, ${C.primary}, transparent)` }}
            />
          )}
        </AnimatePresence>

        {/* ============ 标题区 ============ */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">运行态势</h2>
            <p className="text-xs text-zinc-500">Chat Gateway · 实时执行健康度</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <HealthPill status={health?.status ?? null} />
            {/* 时间范围 */}
            <div className="flex overflow-hidden rounded-lg border border-[#1F2937]">
              {(
                [
                  ['all', '全部'],
                  ['1h', '1h'],
                  ['24h', '24h'],
                  ['7d', '7d']
                ] as Array<[TimeRange, string]>
              ).map(([val, text]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setTimeRange(val)}
                  className={cn(
                    'px-2.5 py-1 text-xs transition-colors',
                    timeRange === val
                      ? 'bg-[#3B82F6] text-white'
                      : 'bg-[#111827] text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load()}
              className="border-[#1F2937] bg-[#111827] text-zinc-300 hover:border-[#3B82F6]/60 hover:text-white"
            >
              <motion.span
                animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
                transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : {}}
                className="inline-block"
              >
                ⟳
              </motion.span>
              刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAutoRefresh((v) => !v)}
              className={cn(
                'border-[#1F2937] text-xs',
                autoRefresh
                  ? 'border-[#3B82F6]/60 bg-[#3B82F6]/15 text-[#60A5FA]'
                  : 'bg-[#111827] text-zinc-400 hover:text-zinc-200'
              )}
            >
              15s 自动{autoRefresh ? '开' : '关'}
            </Button>
          </div>
        </div>

        {/* 工作流摘要条 */}
        {workflows.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>工作流：</span>
            {workflows.map((w) => (
              <span
                key={w.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#1F2937] bg-[#111827] px-2 py-0.5"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: w.active ? C.ok : '#6B7280' }}
                />
                <span className="text-zinc-300">{w.name}</span>
                <span className="text-zinc-500">· {(w.nodes || []).length} 节点</span>
              </span>
            ))}
          </div>
        )}

        {timeRange !== 'all' && (
          <p className="mt-2 text-[11px] text-zinc-500">
            时间范围基于「最近执行」数据在前端过滤，当前统计窗口为最近 {stats?.recent.length ?? rawExecs.length}{' '}
            条记录
          </p>
        )}
        {lastUpdated && (
          <p className="mt-1 text-[11px] text-zinc-600">最近更新 {relativeTime(new Date(lastUpdated).toISOString())}</p>
        )}

        {/* 降级 / 错误横幅 */}
        <AnimatePresence>
          {statsError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <span>⚠</span>
                <span>{statsError}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ============ KPI ============ */}
        {loading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[104px] w-full rounded-xl bg-[#1F2937]" />
            ))}
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="总调用"
              hint={stats ? '最近执行' : undefined}
              onClick={() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <div className="text-[32px] font-semibold leading-none text-zinc-100">
                <CountUp value={kpi.total} />
              </div>
            </KpiCard>

            <KpiCard
              label="成功率"
              hint={`失败 ${kpi.failed}`}
              active={statusF === 'success'}
              onClick={() => void setStatusF(statusF === 'success' ? 'all' : 'success')}
            >
              <RateRing rate={kpi.rate} />
            </KpiCard>

            <KpiCard label="平均延迟" active={sortByLatency} onClick={() => setSortByLatency((v) => !v)}>
              <div className={cn('text-[32px] font-semibold leading-none', latencyClass(kpi.avgLatency))}>
                {kpi.avgLatency === null ? '—' : <CountUp value={kpi.avgLatency} format={(n) => formatMs(n)} />}
              </div>
            </KpiCard>

            <KpiCard label="独立会话" active={sessionOnly} onClick={() => setSessionOnly((v) => !v)}>
              <div className="text-[32px] font-semibold leading-none text-zinc-100">
                <CountUp value={kpi.uniqueSessions} />
              </div>
            </KpiCard>
          </div>
        )}

        {/* ============ 趋势 + 分布 ============ */}
        {loading ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Skeleton className="h-[220px] rounded-xl bg-[#1F2937]" />
            <Skeleton className="h-[220px] rounded-xl bg-[#1F2937]" />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {/* 趋势 */}
            <div className="rounded-xl border border-[#1F2937] bg-[#111827] p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium tracking-wide text-zinc-400">最近执行（按延迟）</span>
                <span className="flex items-center gap-3 text-[10px] text-zinc-500">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm" style={{ background: C.ok }} /> 成功
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm" style={{ background: C.danger }} /> 失败
                  </span>
                </span>
              </div>
              {trendData.length === 0 ? (
                <div className="flex h-[160px] items-center justify-center text-xs text-zinc-500">暂无执行数据</div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={trendData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <XAxis dataKey="label" hide />
                    <YAxis hide />
                    <RechartsTooltip
                      content={<TrendTip />}
                      cursor={{ fill: 'rgba(59,130,246,0.08)' }}
                      isAnimationActive={false}
                    />
                    <Bar dataKey="latency" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                      {trendData.map((d, i) => (
                        <Cell key={i} fill={d.status === 'success' ? C.ok : C.danger} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* 分布 */}
            <div className="grid gap-3 sm:grid-cols-2">
              <DistributionBars
                title="按 Model 分布"
                counts={modelCounts}
                selected={modelF}
                onSelect={(k) => void setModelF(modelF === k ? '' : k)}
                colorFor={() => C.primary}
              />
              <DistributionBars
                title="按 Client 分布"
                counts={clientCounts}
                selected={clientF}
                onSelect={(k) => void setClientF(clientF === k ? '' : k)}
                colorFor={(k) => clientColor(k)}
              />
            </div>
          </div>
        )}

        {/* ============ 筛选条 + 筛选芯片 ============ */}
        <div ref={tableRef} className="mt-4 scroll-mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-[#1F2937]">
              {(
                [
                  ['all', 'All'],
                  ['success', 'Success'],
                  ['error', 'Failed']
                ] as Array<[StatusFilter, string]>
              ).map(([val, text]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => void setStatusF(val)}
                  className={cn(
                    'px-3 py-1 text-xs transition-colors',
                    statusF === val
                      ? 'bg-[#3B82F6] text-white'
                      : 'bg-[#111827] text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  {text}
                </button>
              ))}
            </div>

            <select
              value={modelF}
              onChange={(e) => void setModelF(e.target.value)}
              className="rounded-lg border border-[#1F2937] bg-[#111827] px-2 py-1 text-xs text-zinc-300 outline-none"
            >
              <option value="">全部模型</option>
              {modelCounts.map(([m]) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            <select
              value={clientF}
              onChange={(e) => void setClientF(e.target.value)}
              className="rounded-lg border border-[#1F2937] bg-[#111827] px-2 py-1 text-xs text-zinc-300 outline-none"
            >
              <option value="">全部来源</option>
              {clientCounts.map(([c]) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <div className="relative">
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => void setQ(e.target.value)}
                placeholder="搜索 Session / 执行 ID（按 / 聚焦）"
                className="w-64 rounded-lg border border-[#1F2937] bg-[#111827] px-3 py-1 pr-8 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-[#3B82F6]"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => void setQ('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  ×
                </button>
              )}
            </div>

            <AnimatePresence>
              {hasAnyFilter && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {activeFilterChips.map((chip) => (
                    <span
                      key={chip.label}
                      className="inline-flex items-center gap-1 rounded-full border border-[#3B82F6]/50 bg-[#3B82F6]/15 px-2 py-0.5 text-[11px] text-[#93C5FD]"
                    >
                      {chip.label}
                      <button type="button" onClick={chip.clear} className="hover:text-white">
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => void clearFilters()}
                    className="text-[11px] text-zinc-500 underline hover:text-zinc-300"
                  >
                    清除全部
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ============ 执行表 ============ */}
          {loading ? (
            <div className="mt-3 space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg bg-[#1F2937]" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="mt-3 rounded-xl border border-[#1F2937] bg-[#111827] px-6 py-12 text-center">
              <div className="text-sm text-zinc-300">还没有执行记录</div>
              <div className="mt-1 text-xs text-zinc-500">去 LobeChat 发一条消息，它就会出现在这里。</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="mt-3 rounded-xl border border-[#1F2937] bg-[#111827] px-6 py-12 text-center">
              <div className="text-sm text-zinc-300">没有符合筛选条件的执行</div>
              <button
                type="button"
                onClick={() => void clearFilters()}
                className="mt-1 text-xs text-[#60A5FA] underline"
              >
                清除筛选
              </button>
            </div>
          ) : (
            <div className="mt-3 overflow-hidden rounded-xl border border-[#1F2937]">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1F2937] bg-[#0D1526] text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">模型</th>
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium">Session</th>
                    <th className="px-3 py-2 text-right font-medium">延迟</th>
                    <th className="px-3 py-2 text-right font-medium">Token</th>
                    <th className="px-3 py-2 font-medium">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const isExpanded = expandedId === r.id;
                    const isFailed = r.status !== 'success';
                    const rel = relativeTime(r.endedAt);
                    return (
                      <React.Fragment key={r.id}>
                        <tr
                          onClick={() => setExpandedId(isExpanded ? null : r.id)}
                          className={cn(
                            'cursor-pointer border-b border-[#1F2937]/60 transition-colors hover:bg-white/[0.03]',
                            isExpanded && 'bg-white/[0.04]'
                          )}
                        >
                          <td className={cn('relative px-3 py-2', isFailed && 'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[#EF4444]')}>
                            <span className="text-zinc-300" title={formatDateTime(r.endedAt)}>
                              {rel ?? '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px] text-zinc-300">{r.model ?? '—'}</td>
                          <td className="px-3 py-2">
                            <span
                              className="rounded px-1.5 py-0.5 font-mono text-[11px]"
                              style={{
                                color: clientColor(r.client),
                                background: r.client ? `${clientColor(r.client)}1A` : undefined
                              }}
                            >
                              {r.client ?? 'unknown'}
                            </span>
                          </td>
                          <td className="max-w-[140px] px-3 py-2">
                            {r.sessionId && r.sessionId !== 'unknown' ? (
                              <button
                                type="button"
                                title={'点击复制并按此 Session 筛选：' + r.sessionId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void copyText(r.sessionId!);
                                  void setQ(r.sessionId!);
                                }}
                                className="truncate font-mono text-[11px] text-[#93C5FD] hover:underline"
                              >
                                {copied === r.sessionId ? '已复制 ✓' : r.sessionId}
                              </button>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>
                          <td className={cn('px-3 py-2 text-right tabular-nums', latencyClass(r.latencyMs))}>
                            {formatMs(r.latencyMs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                            {r.totalTokens === null ? (
                              '—'
                            ) : (
                              <span
                                title={
                                  'prompt: ' + (r.promptTokens ?? '—') + ' / completion: ' + (r.completionTokens ?? '—')
                                }
                              >
                                {formatTokens(r.totalTokens)}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isFailed ? (
                              <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-mono text-[11px] text-red-400">
                                {r.errorCode || 'error'}
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>
                        </tr>
                        {/* 展开行：错误详情 / 执行 ID */}
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.tr
                              key={`${r.id}-expanded`}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="border-b border-[#1F2937]/60 bg-[#0D1526]"
                            >
                              <td colSpan={8} className="px-3 py-0">
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  transition={{ duration: 0.2 }}
                                  className="overflow-hidden"
                                >
                                  <div className="flex flex-wrap items-start gap-4 py-3 text-[11px]">
                                    <div className="min-w-[240px] flex-1">
                                      <div className="text-zinc-500">
                                        {isFailed ? '错误信息' : '详情'}
                                      </div>
                                      <div className="mt-1 rounded-md border border-[#1F2937] bg-[#0B1220] p-2 font-mono text-zinc-300">
                                        {isFailed
                                          ? r.errorMessage || '（无错误详情，可在 n8n 编辑器查看该执行）'
                                          : '执行成功。'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-zinc-500">执行 ID</div>
                                      <button
                                        type="button"
                                        onClick={() => void copyText(r.id)}
                                        className="mt-1 rounded-md border border-[#1F2937] bg-[#0B1220] px-2 py-1 font-mono text-[#93C5FD] hover:border-[#3B82F6]/60"
                                      >
                                        {copied === r.id ? '已复制 ✓' : r.id}
                                      </button>
                                    </div>
                                    {r.promptTokens !== null && (
                                      <div>
                                        <div className="text-zinc-500">Token</div>
                                        <div className="mt-1 font-mono text-zinc-300">
                                          prompt {r.promptTokens ?? '—'} · completion {r.completionTokens ?? '—'}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </motion.div>
                              </td>
                            </motion.tr>
                          )}
                        </AnimatePresence>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-[11px] text-zinc-600">
            显示 {filtered.length} / {rows.length} 条
            {statsError ? ' · 数据源：原始执行列表（统计接口不可用）' : ' · 数据源：统计接口'}
            {sortByLatency ? ' · 按延迟降序' : ''}
          </p>
        </div>
      </div>
    
  );
}

/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        success
      </span>
    );
  }
  if (status === 'running' || status === 'waiting') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-400" />
        </span>
        {status}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-400">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      {status}
    </span>
  );
}
