'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { KbIngestDialog } from './kb-ingest-dialog';
import { KbSearchCard } from './kb-search-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface KbDoc {
  doc_id: string;
  title: string;
  source_type: string;
  status: string;
  created_at: string;
  chunks: number;
}

interface KbStats {
  documents?: number;
  chunks?: number;
  embed_tokens_used?: number;
  embed_quota_tokens?: number;
  embed_pct?: number | null;
  error?: string;
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

const num = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US');

const errText = (body: any): string => {
  if (!body) return '请求失败';
  return body?.error?.message || body?.error?.code || body?.error?.type || '请求失败';
};

export function KnowledgePanel() {
  const [docs, setDocs] = useState<KbDoc[] | null>(null);
  const [stats, setStats] = useState<KbStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [listRes, overviewRes] = await Promise.all([
        fetch('/api/n8n/kb', { cache: 'no-store' }),
        fetch('/api/n8n/overview', { cache: 'no-store' })
      ]);
      if (!listRes.ok) throw new Error('列表 HTTP ' + listRes.status);
      const list = await listRes.json();
      setDocs(list.docs || []);
      if (overviewRes.ok) {
        const ov = await overviewRes.json();
        setStats(ov.kb || null);
      }
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retire = async (doc: KbDoc) => {
    setFlash(null);
    try {
      const res = await fetch('/api/n8n/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', doc_id: doc.doc_id })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setFlash({ kind: 'err', text: errText(body) });
        return;
      }
      setFlash({ kind: 'ok', text: `已下架：${doc.title}` });
      await load();
    } catch (e: any) {
      setFlash({ kind: 'err', text: String(e?.message || e) });
    }
  };

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
        <StatCard title='文档' value={num(stats?.documents)} loading={!stats && !loadError} />
        <StatCard title='分块' value={num(stats?.chunks)} loading={!stats && !loadError} />
        <StatCard
          title='嵌入额度'
          value={stats?.embed_pct === null || stats?.embed_pct === undefined ? '—' : stats.embed_pct + '%'}
          sub={num(stats?.embed_tokens_used) + ' / ' + num(stats?.embed_quota_tokens)}
          loading={!stats && !loadError}
        />
      </div>

      {flash ? (
        <div
          className={
            'rounded-md border px-3 py-2 text-sm ' +
            (flash.kind === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-destructive/40 bg-destructive/10 text-destructive')
          }
        >
          {flash.text}
        </div>
      ) : null}

      <KbSearchCard />

      <Card>
        <CardHeader>
          <div className='flex items-center justify-between'>
            <div>
              <CardTitle>知识文档</CardTitle>
              <CardDescription>{docs ? `${docs.length} 篇（含已下架）` : '加载中…'}</CardDescription>
            </div>
            <KbIngestDialog onDone={load} usedTokens={stats?.embed_tokens_used ?? 0} />
          </div>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className='text-destructive text-sm'>加载失败：{loadError}</p>
          ) : docs === null ? (
            <div className='flex flex-col gap-2'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : docs.length === 0 ? (
            <p className='text-muted-foreground text-sm'>暂无文档 —— 用右上角「摄取新文档」添加第一篇。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标题</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>分块</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.doc_id}>
                    <TableCell className='font-medium'>{d.title}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{d.source_type}</TableCell>
                    <TableCell>
                      <Badge variant={d.status === 'active' ? 'default' : 'outline'}>
                        {d.status === 'active' ? '生效中' : '已下架'}
                      </Badge>
                    </TableCell>
                    <TableCell className='tabular-nums'>{d.chunks}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{fmtTime(d.created_at)}</TableCell>
                    <TableCell className='text-right'>
                      {d.status === 'active' ? <RetireButton doc={d} onRetire={retire} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, sub, loading }: { title: string; value: string; sub?: string; loading?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        {loading ? (
          <Skeleton className='h-8 w-24' />
        ) : (
          <CardTitle className='text-3xl font-semibold tabular-nums'>{value}</CardTitle>
        )}
        {sub ? <div className='text-muted-foreground text-xs'>{sub}</div> : null}
      </CardHeader>
    </Card>
  );
}

function RetireButton({ doc, onRetire }: { doc: KbDoc; onRetire: (d: KbDoc) => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button size='sm' variant='outline' className='text-destructive' onClick={() => setConfirming(true)}>
        下架
      </Button>
    );
  }
  return (
    <Button size='sm' variant='destructive' onClick={() => onRetire(doc)}>
      确认下架?
    </Button>
  );
}
