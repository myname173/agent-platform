'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/**
 * 关键词监控。
 *
 * 之前这个能力在界面上完全不存在：工作流每天 21:00 跑，但表里一个关键词都没有，
 * 而且扫描结果只推到 Telegram、不留存 —— 等于既没有开关，也没有记录。
 * 这里把闭环补上：加关键词 → 立即扫描看结果 → 结果留存可回看。
 */
interface Watch {
  keyword: string;
  enabled: boolean;
  last_run_at: string | null;
  last_found: number;
  notes: string[];
}

interface Digest {
  keyword: string;
  notes: string[];
}

const when = (iso?: string | null) => {
  if (!iso) return '从未扫描';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
};

export function TopicsPanel() {
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digests, setDigests] = useState<Digest[] | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/topics', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setError(j?.error || `加载失败（${r.status}）`);
        return;
      }
      setWatches(j.watches || []);
      setError(null);
    } catch (e: any) {
      setError(String((e && e.message) || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: 'add' | 'remove' | 'run', keyword?: string) => {
    setBusy(action + (keyword ? ':' + keyword : ''));
    setError(null);
    if (action === 'run') setDigests(null);
    try {
      const r = await fetch('/api/n8n/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, keyword })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setError(j?.error || `操作失败（${r.status}）`);
        return;
      }
      if (action === 'run') {
        setDigests(j.digests || []);
        setScanned(j.scanned ?? 0);
      }
      if (action === 'add') setKw('');
      await load();
    } catch (e: any) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(null);
    }
  };

  const totalFound = (digests || []).reduce((a, d) => a + d.notes.length, 0);

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>添加关键词</CardTitle>
          <CardDescription>
            每天 21:00 自动检索一次，挑出值得关注的推送到 Telegram。也可以在这里立即扫描。
          </CardDescription>
        </CardHeader>
        <CardContent className='flex gap-2'>
          <Input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && kw.trim() && !busy) act('add', kw.trim()); }}
            placeholder='例如：AI 大模型 监管'
          />
          <Button
            onClick={() => act('add', kw.trim())}
            disabled={busy !== null || !kw.trim()}
            className='shrink-0'
          >
            {busy && busy.startsWith('add') ? '添加中…' : '添加'}
          </Button>
        </CardContent>
      </Card>

      {digests ? (
        <Card>
          <CardHeader>
            <CardTitle>本次扫描</CardTitle>
            <CardDescription>
              扫描 {scanned ?? 0} 个关键词，新发现 {totalFound} 条
              {totalFound === 0 ? '（可能已全部见过）' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-3'>
            {(digests || []).length === 0 ? (
              <p className='text-muted-foreground text-sm'>没有新发现。</p>
            ) : (
              digests.map((d) => (
                <div key={d.keyword} className='flex flex-col gap-1'>
                  <span className='text-sm font-medium'>▸ {d.keyword}</span>
                  {d.notes.map((n, i) => (
                    <p key={i} className='text-muted-foreground text-xs'>
                      • {n}
                    </p>
                  ))}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className='flex items-center justify-between'>
            <div>
              <CardTitle>监控中的关键词</CardTitle>
              <CardDescription>
                {watches ? `${watches.length} 个` : '加载中…'}
              </CardDescription>
            </div>
            <Button
              variant='outline'
              onClick={() => act('run')}
              disabled={busy !== null || !watches || watches.length === 0}
            >
              {busy === 'run' ? '扫描中…' : '立即扫描'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          {error ? <p className='text-destructive text-sm'>{error}</p> : null}

          {watches && watches.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              还没有关键词。先加一个 —— 否则每天 21:00 的自动扫描什么也不会做。
            </p>
          ) : null}

          {(watches || []).map((w) => (
            <div key={w.keyword} className='flex flex-col gap-2 border-b border-dashed pb-3 last:border-0 last:pb-0'>
              <div className='flex items-center justify-between gap-2'>
                <div className='flex min-w-0 items-center gap-2'>
                  <span className='truncate font-medium'>{w.keyword}</span>
                  {w.enabled ? null : <Badge variant='outline'>已停用</Badge>}
                  {w.last_found > 0 ? (
                    <Badge variant='secondary' className='font-normal'>
                      上次 {w.last_found} 条
                    </Badge>
                  ) : null}
                </div>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy !== null}
                  onClick={() => act('remove', w.keyword)}
                  className='shrink-0'
                >
                  移除
                </Button>
              </div>
              <span className='text-muted-foreground text-xs'>{when(w.last_run_at)}</span>
              {w.notes.length ? (
                <div className='flex flex-col gap-0.5'>
                  {w.notes.map((n, i) => (
                    <p key={i} className='text-muted-foreground text-xs'>
                      • {n}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
