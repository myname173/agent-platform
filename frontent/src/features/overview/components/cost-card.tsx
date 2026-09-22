'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

interface CostShape {
  total_cost_usd: number;
  cost_24h_usd: number;
  cost_7d_usd: number;
  by_model: Record<string, number>;
  by_key: Record<string, number>;
}

interface StatsShape {
  cost?: CostShape;
  totals?: { total: number };
  window?: { scanned: number };
  recent?: Array<{ model?: string; key_name?: string; cost_usd?: number; created_at?: string }>;
}

interface SettingsShape {
  cost?: { budget_24h_usd: number; critical_24h_usd: number };
  note?: string;
}

const usd = (v: number | null | undefined, digits = 4) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? '—'
    : '$' + Number(v).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      });

export function CostCard() {
  const [stats, setStats] = useState<StatsShape | null>(null);
  const [budget, setBudget] = useState<{ budget_24h_usd: number; critical_24h_usd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, st] = await Promise.all([
        fetch('/api/n8n/stats', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/n8n/settings', { cache: 'no-store' }).then((r) => r.json())
      ]);
      setStats(s || null);
      const c = (st as SettingsShape)?.cost;
      setBudget(c ? { budget_24h_usd: Number(c.budget_24h_usd), critical_24h_usd: Number(c.critical_24h_usd) } : null);
      setError((s && s.error) || null);
    } catch (e: any) {
      setError(String((e && e.message) || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cost = stats?.cost;
  const spend24 = Number(cost?.cost_24h_usd || 0);
  const limit = budget?.budget_24h_usd || 0;
  const critical = budget?.critical_24h_usd || 0;
  const pct = limit > 0 ? Math.min(100, (spend24 / limit) * 100) : null;
  const over = limit > 0 && spend24 >= limit;
  const criticalNow = critical > 0 && spend24 >= critical;

  const topModels = Object.entries(cost?.by_model || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4);
  const topKeys = Object.entries(cost?.by_key || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4);

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型成本</CardTitle>
        <CardDescription>
          按牌价折算的实际花费。超过 24h 预算会写入告警（warn），超过 critical 阈值升级为 critical。
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        {loading ? (
          <span className='text-muted-foreground'>加载中…</span>
        ) : error || !cost ? (
          <span className='text-muted-foreground'>{error || '成本统计暂不可用'}</span>
        ) : (
          <>
            <div className='grid grid-cols-3 gap-2'>
              <Cell label='近 24h' value={usd(cost.cost_24h_usd)} />
              <Cell label='近 7 天' value={usd(cost.cost_7d_usd)} />
              <Cell label='累计' value={usd(cost.total_cost_usd)} />
            </div>

            {pct !== null ? (
              <div className='flex flex-col gap-1 border-t pt-3'>
                <div className='flex items-center justify-between'>
                  <span className='text-muted-foreground'>24h 预算</span>
                  <span className='font-medium tabular-nums'>
                    {usd(spend24)} / {usd(limit, 2)} · {pct.toFixed(1)}%
                  </span>
                </div>
                <Progress
                  value={pct}
                  className={criticalNow ? 'h-2 [&>div]:bg-red-600' : over ? 'h-2 [&>div]:bg-amber-500' : 'h-2'}
                />
                <div className='flex items-center gap-2'>
                  {criticalNow ? (
                    <Badge variant='destructive'>已超critical阈值 {usd(critical, 2)}</Badge>
                  ) : over ? (
                    <Badge className='bg-amber-500 text-white hover:bg-amber-500'>已超预算</Badge>
                  ) : (
                    <Badge
                      variant='outline'
                      className='text-emerald-700 dark:text-emerald-400'
                    >
                      预算内
                    </Badge>
                  )}
                  <span className='text-muted-foreground text-xs'>
                    critical 阈值 {usd(critical, 2)}
                  </span>
                </div>
              </div>
            ) : null}

            {topModels.length ? (
              <div className='flex flex-col gap-1 border-t pt-3'>
                <span className='text-muted-foreground'>按模型</span>
                {topModels.map(([k, v]) => (
                  <Row key={k} label={k} value={usd(v)} />
                ))}
              </div>
            ) : null}

            {topKeys.length ? (
              <div className='flex flex-col gap-1 border-t pt-3'>
                <span className='text-muted-foreground'>按调用方（key）</span>
                {topKeys.map(([k, v]) => (
                  <Row key={k} label={k} value={usd(v)} />
                ))}
              </div>
            ) : null}

            <div className='flex items-center justify-between border-t pt-3'>
              <span className='text-muted-foreground text-xs'>
                扫描 {stats?.window?.scanned ?? '—'} 条执行记录
              </span>
              <Button size='sm' variant='outline' onClick={load}>
                刷新
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex flex-col rounded-md border p-2'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='font-semibold tabular-nums'>{value}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-center justify-between'>
      <span className='text-muted-foreground truncate'>{label}</span>
      <span className='font-medium tabular-nums'>{value}</span>
    </div>
  );
}
