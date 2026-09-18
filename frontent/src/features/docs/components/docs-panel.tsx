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

interface DocItem {
  id: number;
  title: string;
  kind: string;
  summary: string;
  source_ref: string;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  minutes: '会议纪要',
  weekly: '周报',
  brief: '晨报',
  custom: '自定义'
};

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

const errText = (body: any): string => {
  if (!body) return '请求失败';
  return body?.error?.message || body?.error?.code || body?.error?.type || '请求失败';
};

export function DocsPanel() {
  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/docs', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      setDocs(j.docs || []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(
    async (payload: { kind: string; title?: string; text?: string }, label: string) => {
      setBusy(payload.kind);
      setFlash(null);
      try {
        const res = await fetch('/api/n8n/docs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          setFlash({ kind: 'err', text: errText(body) });
          return null;
        }
        setFlash({
          kind: 'ok',
          text: `${label}已生成：#${body.id} ${body.title}${body.actions ? ` · 抽出 ${body.actions} 条行动项` : ''}`
        });
        await load();
        return body;
      } catch (e: any) {
        setFlash({ kind: 'err', text: String(e?.message || e) });
        return null;
      } finally {
        setBusy('');
      }
    },
    [load]
  );

  const act = useCallback(
    async (id: number, action: 'share' | 'archive' | 'sign') => {
      setBusy(action + ':' + id);
      setFlash(null);
      try {
        const res = await fetch('/api/n8n/docs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, id })
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          setFlash({ kind: 'err', text: errText(body) });
          return;
        }
        if (action === 'share') {
          setFlash({
            kind: 'ok',
            text: body.degraded
              ? `已推送（对方无通道，已回落给你）：${body.url}`
              : `已推送到 TG：${body.url}`
          });
        } else if (action === 'sign') {
          let copied = false;
          try {
            await navigator.clipboard.writeText(body.url);
            copied = true;
          } catch {
            /* clipboard unavailable */
          }
          setFlash({
            kind: 'ok',
            text: copied
              ? `免登录链接已复制（${body.expires_in_days} 天有效）：${body.url}`
              : `免登录链接（${body.expires_in_days} 天有效，复制失败请手动选取）：${body.url}`
          });
        } else {
          setFlash({ kind: 'ok', text: `已归档进知识库：${body.doc_id || '—'} · ${body.chunks || 0} 个片段` });
        }
      } catch (e: any) {
        setFlash({ kind: 'err', text: String(e?.message || e) });
      } finally {
        setBusy('');
      }
    },
    []
  );

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='text-muted-foreground text-sm'>
          文档工厂：把平台里的内容变成<b>能发出去、能打印</b>的成品。生成后点标题即在新标签页打开，浏览器里可直接打印或另存为 PDF。
          「推送」把链接发到 TG；「复制链接」生成 <b>7 天有效的免登录链接</b>，可以直接发给别人看；「归档」把正文存进知识库，之后对话里就能问到它。
        </div>
        <div className='flex flex-wrap gap-2'>
          <MinutesDialog onCreated={load} busy={busy} create={create} />
          <Button
            variant='outline'
            disabled={busy === 'weekly'}
            onClick={() => create({ kind: 'weekly' }, '周报文档')}
          >
            {busy === 'weekly' ? '生成中…' : '导出本周周报'}
          </Button>
          <Button
            variant='outline'
            disabled={busy === 'brief'}
            onClick={() => create({ kind: 'brief' }, '晨报文档')}
          >
            {busy === 'brief' ? '生成中…' : '导出最新晨报'}
          </Button>
        </div>
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
          <CardTitle>文档</CardTitle>
          <CardDescription>{docs ? `${docs.length} 份` : '加载中…'}</CardDescription>
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
            <p className='text-muted-foreground text-sm'>
              还没有文档 —— 用右上角「整理会议纪要」粘贴一段记录，或直接导出周报 / 晨报。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标题</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>生成时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className='font-medium'>
                      <a
                        href={`/api/n8n/docs/${d.id}`}
                        target='_blank'
                        rel='noreferrer'
                        className='hover:underline'
                      >
                        {d.title}
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge variant='outline'>{KIND_LABEL[d.kind] || d.kind}</Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground max-w-[280px] truncate text-xs'>
                      {d.summary || '—'}
                    </TableCell>
                    <TableCell className='text-muted-foreground font-mono text-xs'>
                      {String(d.source_ref || '').slice(0, 28) || '—'}
                    </TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{fmtTime(d.created_at)}</TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button size='sm' variant='outline' render={<a href={`/api/n8n/docs/${d.id}`} target='_blank' rel='noreferrer' />}>
                          打开
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith('share')}
                          onClick={() => act(d.id, 'share')}
                        >
                          {busy === 'share:' + d.id ? '…' : '推送'}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith('sign')}
                          onClick={() => act(d.id, 'sign')}
                        >
                          {busy === 'sign:' + d.id ? '…' : '复制链接'}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith('archive')}
                          onClick={() => act(d.id, 'archive')}
                        >
                          {busy === 'archive:' + d.id ? '…' : '归档'}
                        </Button>
                      </div>
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

/* ---------- minutes dialog ---------- */

function MinutesDialog({
  onCreated,
  busy,
  create
}: {
  onCreated: () => void;
  busy: string;
  create: (p: { kind: string; title?: string; text?: string }, label: string) => Promise<any>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!text.trim()) {
      setError('请粘贴会议记录原文');
      return;
    }
    const body = await create({ kind: 'minutes', title: title.trim() || undefined, text }, '会议纪要');
    if (body) {
      setOpen(false);
      setTitle('');
      setText('');
      onCreated();
    } else {
      setError('生成失败，稍后再试');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>整理会议纪要</DialogTrigger>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>整理会议纪要</DialogTitle>
          <DialogDescription>
            把会议记录原文粘进来（不用排版）。会自动抽出议题、结论和行动项，并把中文日期换算成截止日。
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1.5'>
            <Label>标题（可留空）</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='例如：Q3 复盘会' />
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label>会议记录原文</Label>
            <textarea
              className='border-input min-h-[220px] w-full rounded-md border bg-transparent px-3 py-2 text-sm'
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'9月18日 Q3 复盘会。参会：张伟、李娜。\n议题一：……\n行动项：张伟负责在 9 月 25 日前……'}
            />
          </div>
          {error ? <p className='text-destructive text-sm'>{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={busy === 'minutes'} onClick={submit}>
            {busy === 'minutes' ? '整理中…' : '生成纪要'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
