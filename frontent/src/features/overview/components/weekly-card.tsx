'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Review {
  id: number;
  week_start?: string;
  week_end?: string;
  content_md?: string;
  scope?: string;
  people_count?: number;
  stats_json?: string;
  createdAt?: string;
}

const fmt = (iso?: string) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
};

export function WeeklyCard() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/weekly', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setMsg((j && (j.error || j.reason)) || '加载失败');
        setReviews(j.reviews || []);
        return;
      }
      setReviews(j.reviews || []);
      setMsg(null);
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (scope: 'owner' | 'team') => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/n8n/weekly/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || (j && j.ok === false)) {
        setMsg((j && (j.error || j.reason)) || '生成失败');
      } else {
        setMsg(scope === 'team' ? '已生成团队视图并推送 TG' : '已生成并推送 TG');
      }
      await load();
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const latest = reviews[0];
  const stats = (r?: Review) => {
    try {
      return r && r.stats_json ? JSON.parse(r.stats_json) : null;
    } catch {
      return null;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>周报</CardTitle>
        <CardDescription>每周日 20:00 自动生成并推送 TG；这里可查看历次回顾，或手动试跑一次。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        {!latest ? (
          <span className='text-muted-foreground'>暂无周报（首个周报将在周日 20:00 自动生成）。</span>
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant='outline'>
                {latest.week_start} ~ {latest.week_end}
              </Badge>
              {latest.scope === 'team' ? (
                <Badge variant='secondary' className='font-normal'>
                  团队视图{latest.people_count ? ` · ${latest.people_count} 人` : ''}
                </Badge>
              ) : null}
              {(() => {
                const s = stats(latest);
                return s ? (
                  <span className='text-muted-foreground text-xs'>
                    待办 {s.done ?? 0}/{Number(s.done || 0) + Number(s.open || 0)}
                    {s.assigned ? ` · 已指派 ${s.assigned}` : ''} · 提醒 {s.sent ?? 0} · 对话 {s.execs ?? 0} · 记忆 {s.mems ?? 0}
                  </span>
                ) : null;
              })()}
              <span className='text-muted-foreground text-xs'>{fmt(latest.createdAt)}</span>
            </div>
            <pre className='bg-muted/40 max-h-72 overflow-auto rounded-md border p-3 text-xs leading-relaxed whitespace-pre-wrap'>
              {latest.content_md}
            </pre>
          </>
        )}
        {reviews.length > 1 ? (
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-xs'>历史</span>
            {reviews.slice(1, 8).map((r) => (
              <div key={r.id} className='flex items-center justify-between border-b border-dashed pb-1 last:border-0'>
                <span className='flex items-center gap-2'>
                  {r.week_start} ~ {r.week_end}
                  {r.scope === 'team' ? (
                    <Badge variant='secondary' className='font-normal'>
                      团队
                    </Badge>
                  ) : null}
                </span>
                <span className='text-muted-foreground text-xs'>{fmt(r.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {msg ? <span className='text-muted-foreground'>{msg}</span> : null}
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='outline' disabled={busy} onClick={() => run('owner')}>
            {busy ? '生成中…' : '立即生成'}
          </Button>
          <Button size='sm' variant='outline' disabled={busy} onClick={() => run('team')}>
            生成团队视图
          </Button>
          <Button size='sm' variant='ghost' onClick={load}>
            刷新
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
