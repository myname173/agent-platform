'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

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

      <Card>
        <CardHeader>
          <div className='flex items-center justify-between'>
            <div>
              <CardTitle>知识文档</CardTitle>
              <CardDescription>{docs ? `${docs.length} 篇（含已下架）` : '加载中…'}</CardDescription>
            </div>
            <IngestDialog onDone={load} />
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

function IngestDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/n8n/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ingest', title, text })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(errText(body));
        return;
      }
      setResult(
        '摄取完成：' + body.action + ' · ' + (body.chunks ?? 0) + ' 块 · 计费 ' + (body.tokens_billed ?? 0) + ' tokens' +
          (body.cumulative_embed_tokens !== undefined && body.cumulative_embed_tokens !== null
            ? '（累计 ' + body.cumulative_embed_tokens + '）'
            : '')
      );
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setTitle('');
      setText('');
      setError(null);
      setResult(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<Button />}>摄取新文档</DialogTrigger>
      <DialogContent className='sm:max-w-lg'>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>摄取成功</DialogTitle>
              <DialogDescription>{result}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => close(false)}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>摄取新文档</DialogTitle>
              <DialogDescription>内容将按约 750 字符切块并嵌入（消耗嵌入额度）。相同内容会自动跳过。</DialogDescription>
            </DialogHeader>
            <div className='flex flex-col gap-3'>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='kb-title'>标题</Label>
                <Input id='kb-title' value={title} onChange={(e) => setTitle(e.target.value)} placeholder='例如：平台运维手册 v2' />
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='kb-text'>正文</Label>
                <Textarea id='kb-text' rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='粘贴文档正文…' />
              </div>
              {error ? <p className='text-destructive text-sm'>{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => close(false)}>
                取消
              </Button>
              <Button disabled={busy || !title || !text} onClick={submit}>
                {busy ? '摄取中…' : '摄取'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
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
