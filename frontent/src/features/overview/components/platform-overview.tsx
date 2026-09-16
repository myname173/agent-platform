'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PushMobileCard } from './push-mobile-card';

interface OverviewPayload {
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

const num = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function PlatformOverview() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/n8n/overview', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((e) => {
        if (alive) setError(String((e && e.message) || e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>总览加载失败</CardTitle>
          <CardDescription>请检查 n8n Platform Admin API（/admin/overview）与网络连通性。</CardDescription>
        </CardHeader>
        <CardContent className='text-muted-foreground text-sm'>{error}</CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4'>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-8 w-32' />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  const c = data.chat_24h;
  const kb = data.kb || {};
  const errPct = (c.error_rate * 100).toFixed(1) + '%';

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4'>
        <Kpi title='近 24h 对话量' value={num(c.total)} sub={'成功 ' + num(c.success) + ' · 失败 ' + num(c.error)} />
        <Kpi title='错误率' value={errPct} sub={'独立会话 ' + num(c.unique_sessions) + ' 个'} />
        <Kpi title='平均延迟' value={num(c.avg_latency_ms) + ' ms'} sub='成功请求均值' />
        <Kpi title='近 24h 成本' value={'$' + num(c.cost_usd, 4)} sub='USD（按牌价折算）' />
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-3'>
        <Card className='lg:col-span-2'>
          <CardHeader>
            <CardTitle>最近告警</CardTitle>
            <CardDescription>来自 Chat Alerts（错误率 / 嵌入额度）。</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {data.alerts.recent.length === 0 ? (
              <p className='text-muted-foreground text-sm'>暂无告警记录。</p>
            ) : (
              data.alerts.recent.slice(0, 8).map((a, i) => (
                <div key={i} className='flex items-start justify-between gap-3 border-b pb-2 last:border-b-0'>
                  <div className='flex flex-col'>
                    <span className='text-sm'>{a.message || a.kind}</span>
                    <span className='text-muted-foreground text-xs'>{formatTime(a.created_at)}</span>
                  </div>
                  <Badge variant='outline'>{a.kind}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>知识库</CardTitle>
            <CardDescription>文档 / 分块 / 嵌入额度。</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-3'>
            {kb.error ? (
              <p className='text-muted-foreground text-sm'>统计暂不可用：{kb.error}</p>
            ) : (
              <>
                <Metric label='文档' value={num(kb.documents)} />
                <Metric label='分块' value={num(kb.chunks)} />
                <Metric label='嵌入已用' value={num(kb.embed_tokens_used) + ' / ' + num(kb.embed_quota_tokens)} />
                <Metric
                  label='额度'
                  value={kb.embed_pct === null || kb.embed_pct === undefined ? '—' : kb.embed_pct + '%'}
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <PushMobileCard />

      <p className='text-muted-foreground text-xs'>
        数据窗口：扫描 {num(data.chat_window.scanned)} 条执行记录 · 生成于 {formatTime(data.generated_at)}
      </p>
    </div>
  );
}

function Kpi({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className='text-3xl font-semibold tabular-nums'>{value}</CardTitle>
        {sub ? <div className='text-muted-foreground text-xs'>{sub}</div> : null}
      </CardHeader>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-center justify-between text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium tabular-nums'>{value}</span>
    </div>
  );
}

function formatTime(iso?: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
