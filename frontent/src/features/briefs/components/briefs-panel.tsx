'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface BriefItem {
  id: number | string;
  title: string;
  content_md: string;
  brief_date: string;
  meta: string | null;
  created_at: string;
}

interface BriefsPayload {
  ok: boolean;
  count: number;
  briefs: BriefItem[];
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso || '';
  }
};

export function BriefsPanel() {
  const [briefs, setBriefs] = useState<BriefItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/briefs', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as BriefsPayload;
      setBriefs(data.briefs || []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenResult(null);
    try {
      const res = await fetch('/api/n8n/briefs', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.title) {
        setGenResult({ ok: true, text: `已生成：${body.title}` });
      } else {
        setGenResult({ ok: false, text: (body && (body.error?.message || body.error)) || `生成失败（HTTP ${res.status}）` });
      }
      await load();
    } catch (e: any) {
      setGenResult({ ok: false, text: String(e?.message || e) });
    } finally {
      setGenerating(false);
    }
  }, [load]);

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <Button onClick={generate} disabled={generating}>
          {generating ? '生成中…' : '立即生成'}
        </Button>
        <Button variant='outline' onClick={load}>
          刷新
        </Button>
        {genResult && (
          <Badge
            variant={genResult.ok ? 'default' : 'destructive'}
            className={genResult.ok ? 'bg-emerald-600 text-white hover:bg-emerald-600' : ''}
          >
            {genResult.text}
          </Badge>
        )}
      </div>

      {loadError && (
        <Card>
          <CardContent className='pt-6 text-sm text-red-600'>加载失败：{loadError}</CardContent>
        </Card>
      )}

      {!briefs && !loadError && <Skeleton className='h-40 w-full' />}

      {briefs && briefs.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>还没有晨报</CardTitle>
            <CardDescription>每天 08:30 自动生成；点击「立即生成」可以马上试一份。</CardDescription>
          </CardHeader>
        </Card>
      )}

      {briefs &&
        briefs.map((b) => (
          <Card key={String(b.id)}>
            <CardHeader className='pb-2'>
              <CardTitle className='text-base'>{b.title}</CardTitle>
              <CardDescription>
                {b.brief_date} · 生成于 {fmtTime(b.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className='whitespace-pre-wrap text-sm leading-6'>{b.content_md}</div>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}
