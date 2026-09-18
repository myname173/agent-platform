'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface DPerson {
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

interface Delegation {
  ok: boolean;
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
  people: DPerson[];
  attention: string[];
}

const ROLE_LABEL: Record<string, string> = { owner: '机主', member: '成员', guest: '外部' };

const fmtAck = (h: number | null) => {
  if (h === null || h === undefined) return '—';
  if (h < 1) return '<1 小时';
  if (h < 24) return Math.round(h) + ' 小时';
  return (Math.round((h / 24) * 10) / 10) + ' 天';
};

export function DelegationCard() {
  const [data, setData] = useState<Delegation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/delegation', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.ok === false) throw new Error(j.error || 'upstream error');
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(String((e && e.message) || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const t = data?.totals;
  const rows = (data?.people || []).filter((p) => p.open > 0 || p.overdue > 0 || p.never_acked > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>派发</CardTitle>
        <CardDescription>
          我派出去的事卡在谁那：逾期、待回执、平均多久回、谁从不回执。数字实时取自待办的负责人与回执字段。
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        {error ? (
          <p className='text-destructive text-sm'>加载失败：{error}</p>
        ) : data === null ? (
          <div className='flex flex-col gap-2'>
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className='h-8 w-full' />
            ))}
          </div>
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant='outline'>开放 {t?.assigned_open ?? 0}</Badge>
              {t?.overdue ? (
                <Badge variant='destructive'>逾期 {t.overdue}</Badge>
              ) : (
                <Badge variant='outline'>逾期 0</Badge>
              )}
              <Badge variant='outline'>待回执 {t?.awaiting_ack ?? 0}</Badge>
              {t?.escalated ? <Badge variant='destructive'>已升级 {t.escalated}</Badge> : null}
              <Badge variant='outline'>近 7 天完成 {t?.done_7d ?? 0}</Badge>
              <span className='text-muted-foreground text-xs'>
                未指派 {t?.unassigned_open ?? 0} 项归我自己
              </span>
            </div>

            {t?.channel_less ? (
              <div className='rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400'>
                {t.channel_less} 人没有直达通道，投递与催办会回落给机主（不会静默丢失，但对方收不到）。
              </div>
            ) : null}

            {data.oldest_waiting ? (
              <div className='bg-muted/40 rounded-md border px-3 py-2 text-xs'>
                卡最久：
                <span className='font-medium'>
                  #{data.oldest_waiting.id} {data.oldest_waiting.text}
                </span>
                <span className='text-muted-foreground'>
                  （{data.oldest_waiting.owner} · 逾期 {data.oldest_waiting.days_late} 天）
                </span>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <span className='text-muted-foreground'>目前没有派出去的事 —— 都在自己手上。</span>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>负责人</TableHead>
                    <TableHead className='text-right'>开放</TableHead>
                    <TableHead className='text-right'>逾期</TableHead>
                    <TableHead className='text-right'>待回执</TableHead>
                    <TableHead className='text-right'>平均回执</TableHead>
                    <TableHead className='text-right'>近 7 天完成</TableHead>
                    <TableHead className='text-right'>从不回执</TableHead>
                    <TableHead>通道</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell>
                        <div className='font-medium'>{p.display_name}</div>
                        <div className='text-muted-foreground text-xs'>{ROLE_LABEL[p.role] || p.role}</div>
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>{p.open}</TableCell>
                      <TableCell className='text-right tabular-nums'>
                        {p.overdue > 0 ? (
                          <span className='text-destructive font-medium'>
                            {p.overdue}
                            {p.oldest_overdue_days ? ` (最久 ${p.oldest_overdue_days}d)` : ''}
                          </span>
                        ) : (
                          '0'
                        )}
                      </TableCell>
                      <TableCell className='text-right tabular-nums'>{p.awaiting_ack}</TableCell>
                      <TableCell className='text-muted-foreground text-right tabular-nums'>{fmtAck(p.avg_ack_hours)}</TableCell>
                      <TableCell className='text-right tabular-nums'>{p.done_7d}</TableCell>
                      <TableCell className='text-right tabular-nums'>{p.never_acked || '—'}</TableCell>
                      <TableCell>
                        {p.has_channel ? (
                          <Badge variant='secondary' className='font-normal'>
                            直达
                          </Badge>
                        ) : (
                          <Badge variant='outline' className='text-amber-600 dark:text-amber-400 font-normal'>
                            回落
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        <div className='flex justify-end'>
          <Button size='sm' variant='ghost' onClick={load}>
            刷新
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
