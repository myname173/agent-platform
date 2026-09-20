'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

const TARGET_CHARS = 750;
const OVERLAP_CHARS = 80;

function chunkText(text: string): string[] {
  const sections = text.split(/\n(?=#{1,6}\s)/);
  const out: string[] = [];
  for (const section of sections) {
    // 只压横向空白，保留换行 —— 换行本身就是段落边界
    const flat = section.replace(/[ \t\r]+/g, ' ');
    const sents = flat.match(/[^。！？!?.；;\n]+[。！？!?.；;\n]?/g) || [flat];
    let cur = '';
    for (const s of sents) {
      if (cur && (cur + s).length > TARGET_CHARS) {
        out.push(cur.trim());
        cur = cur.slice(-Math.min(OVERLAP_CHARS, cur.length)) + s;
      } else {
        cur += s;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // Fallback: text with no sentence punctuation (an English paper, typically)
  // never hits a boundary and arrives here as one enormous chunk. Hard-split
  // anything well over target, preferring a space, keeping the overlap.
  // Kept in step with the workflow copy — otherwise the preview lies.
  const final: string[] = [];
  for (const c of out) {
    if (c.length <= TARGET_CHARS * 1.5) {
      final.push(c);
      continue;
    }
    let i = 0;
    while (i < c.length) {
      let cut = Math.min(i + TARGET_CHARS, c.length);
      if (cut < c.length) {
        const sp = c.lastIndexOf(' ', cut);
        if (sp > i + TARGET_CHARS * 0.5) cut = sp + 1;
      }
      final.push(c.slice(i, cut).trim());
      if (cut >= c.length) break;
      i = Math.max(cut - OVERLAP_CHARS, i + 1);
    }
  }
  return final.filter((x) => x.length > 0);
}

const EMBED_QUOTA = 1_000_000;
const CHARS_PER_TOKEN = 1.5;

function estimateTokens(chunks: string[]): number {
  return chunks.reduce((acc, c) => acc + Math.ceil(c.length / CHARS_PER_TOKEN), 0);
}

interface IngestDialogProps {
  onDone: () => void;
  usedTokens?: number;
}

/** 队列里的一篇：读出来 → 算好分块 → 等摄取 → 出结果（或失败） */
interface QueueItem {
  id: string;
  name: string;
  text: string;
  chunks: number;
  status: 'reading' | 'ready' | 'ingesting' | 'done' | 'skipped' | 'error';
  note?: string;
  ingestedChunks?: number;
  ingestedTokens?: number;
}

const ACCEPT = '.txt,.md,.markdown,.pdf,.docx';

const isPdf = (n: string) => /\.pdf$/i.test(n);
const isDocx = (n: string) => /\.docx$/i.test(n);

/* PDF / DOCX 的解析库都不小，按需加载，不进首屏。 */
async function extractFileText(f: File): Promise<{ text: string; warning?: string }> {
  if (isDocx(f.name)) {
    const mammoth = await import('mammoth');
    const out = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
    const text = (out.value || '').trim();
    return text ? { text } : { text: '', warning: '这份 .docx 没有解析出文本。' };
  }
  if (isPdf(f.name)) {
    const pdfjs: any = await import('pdfjs-dist');
    // webpack 会把 worker 作为资源打包出来
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();
    const doc = await pdfjs.getDocument({ data: await f.arrayBuffer() }).promise;
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // 逐个 item 拼接，遇到 y 坐标变化补换行，尽量保留段落结构
      let lastY: number | null = null;
      let line = '';
      for (const it of content.items as any[]) {
        if (typeof it.str !== 'string') continue;
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
          parts.push(line);
          line = '';
        }
        line += it.str;
        if (y !== null) lastY = y;
      }
      if (line) parts.push(line);
      parts.push('');
    }
    const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) {
      return {
        text: '',
        warning: '这份 PDF 没有文本层（多半是扫描件/图片版）。需要 OCR 才能入库，当前不支持。'
      };
    }
    return { text };
  }
  return { text: await f.text() };
}

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  reading: '读取中',
  ready: '待摄取',
  ingesting: '摄取中',
  done: '完成',
  skipped: '已跳过',
  error: '失败'
};

export function KbIngestDialog({ onDone, usedTokens = 0 }: IngestDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [chunks, setChunks] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processText = useCallback(
    (raw: string, filename?: string) => {
      setText(raw);
      const c = chunkText(raw);
      setChunks(c);
      if (filename && !title) {
        setTitle(filename.replace(/\.[^.]+$/, ''));
      }
    },
    [title]
  );

  /** 读一批文件：逐个解析，每读好一个就更新状态，失败的不影响其它 */
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setError(null);
      setBusy(true);

      const items: QueueItem[] = files.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name,
        text: '',
        chunks: 0,
        status: 'reading' as const
      }));
      setQueue((prev) => [...prev, ...items]);

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const id = items[i].id;
        try {
          const { text: raw, warning } = await extractFileText(f);
          const n = raw ? chunkText(raw).length : 0;
          setQueue((prev) =>
            prev.map((q) =>
              q.id === id
                ? {
                    ...q,
                    text: raw,
                    chunks: n,
                    status: raw ? ('ready' as const) : ('error' as const),
                    note: warning || (raw ? undefined : '没有读到内容')
                  }
                : q
            )
          );
          // 单文件时沿用旧体验：直接带出标题和分块预览
          if (files.length === 1) processText(raw, f.name);
        } catch (e: any) {
          setQueue((prev) =>
            prev.map((q) =>
              q.id === id
                ? { ...q, status: 'error' as const, note: String((e && e.message) || e) }
                : q
            )
          );
        }
      }
      setBusy(false);
    },
    [processText]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) addFiles(files);
    },
    [addFiles]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) addFiles(files);
    // 允许再次选择同一批文件
    e.target.value = '';
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    processText(e.target.value);
  };

  const removeFromQueue = (id: string) => setQueue((prev) => prev.filter((q) => q.id !== id));

  const pending = queue.filter((q) => q.status === 'ready');
  const readyChunks = pending.reduce((a, q) => a + q.chunks, 0);

  // 批量时按队列合计；单文件（或纯粘贴）时用当前预览
  const shownChunks = queue.length > 1 ? readyChunks : chunks.length;
  const shownTokens =
    queue.length > 1
      ? pending.reduce((a, q) => a + Math.ceil(q.text.length / CHARS_PER_TOKEN), 0)
      : estimateTokens(chunks);
  const projectedUsed = usedTokens + shownTokens;
  const projectedPct = Math.round((projectedUsed / EMBED_QUOTA) * 100);

  const ingestOne = async (item: QueueItem): Promise<'ok' | 'skipped' | 'error'> => {
    setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'ingesting' as const } : q)));
    try {
      const res = await fetch('/api/n8n/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'ingest',
          title: item.name.replace(/\.[^.]+$/, ''),
          text: item.text
        })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? { ...q, status: 'error' as const, note: body?.error || `摄取失败（${res.status}）` }
              : q
          )
        );
        return 'error';
      }
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: body.action === 'skipped' ? ('skipped' as const) : ('done' as const),
                ingestedChunks: body.chunks ?? q.chunks,
                ingestedTokens: body.tokens_billed ?? 0
              }
            : q
        )
      );
      return body.action === 'skipped' ? 'skipped' : 'ok';
    } catch (e: any) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: 'error' as const, note: String((e && e.message) || e) } : q
        )
      );
      return 'error';
    }
  };

  /** 批量摄取：一篇一篇来 —— 嵌入 API 有并发与额度，串行既能报进度也更好定位失败 */
  const runBatch = async () => {
    if (!pending.length) return;
    setBusy(true);
    setError(null);

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let blocks = 0;
    let tokens = 0;
    for (const item of pending) {
      const r = await ingestOne(item);
      if (r === 'ok') ok += 1;
      else if (r === 'skipped') skipped += 1;
      else failed += 1;
    }
    for (const q of queue) {
      if (q.status === 'done' || q.status === 'skipped') {
        blocks += q.ingestedChunks ?? 0;
        tokens += q.ingestedTokens ?? 0;
      }
    }

    const parts = [`完成 ${ok} 篇`];
    if (skipped) parts.push(`跳过 ${skipped} 篇（内容相同）`);
    if (failed) parts.push(`失败 ${failed} 篇`);
    parts.push(`共 ${blocks} 块 · 计费 ${tokens.toLocaleString()} tokens`);
    setResult(parts.join(' · '));
    if (ok || skipped) onDone();
    setBusy(false);
  };

  const submit = async () => {
    if (queue.length > 1) {
      await runBatch();
      return;
    }
    if (!title || !text) return;
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
        setError(body?.error || '摄取失败');
        return;
      }
      setResult(
        (body.action === 'skipped' ? '已跳过（内容相同）' : '摄取完成') +
          ' · ' +
          (body.chunks ?? 0) +
          ' 块 · ' +
          (body.tokens_billed ?? shownTokens) +
          ' tokens'
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
      setChunks([]);
      setQueue([]);
      setError(null);
      setResult(null);
    }
  };

  const batch = queue.length > 1;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<Button />}>摄取新文档</DialogTrigger>
      <DialogContent className='sm:max-w-2xl'>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>✅ 摄取成功</DialogTitle>
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
              <DialogDescription>
                可一次选多个文件（.txt / .md / .pdf / .docx），也可以粘贴内容，预览分块后再提交。
              </DialogDescription>
            </DialogHeader>

            <div className='flex flex-col gap-4'>
              <div
                className={
                  'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-6 text-sm transition-colors ' +
                  (dragging
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/60')
                }
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <span>点击或拖入文件（可多选）</span>
                <span className='text-muted-foreground mt-1 text-xs'>{ACCEPT}</span>
                <input ref={inputRef} type='file' multiple accept={ACCEPT} className='hidden' onChange={onInputChange} />
              </div>

              {batch && (
                <div className='flex flex-col gap-1.5'>
                  <div className='flex items-center justify-between'>
                    <span className='text-xs font-medium'>待摄取 {queue.length} 篇</span>
                    <span className='text-muted-foreground text-xs'>
                      就绪 {pending.length} · 合计 {readyChunks} 块
                    </span>
                  </div>
                  <ScrollArea className='max-h-52 rounded-md border'>
                    <div className='flex flex-col gap-1.5 p-2'>
                      {queue.map((q) => (
                        <div key={q.id} className='flex items-center justify-between gap-2 text-xs'>
                          <div className='flex min-w-0 items-center gap-2'>
                            <Badge
                              variant={
                                q.status === 'error'
                                  ? 'destructive'
                                  : q.status === 'done'
                                    ? 'default'
                                    : 'outline'
                              }
                              className='shrink-0 font-normal'
                            >
                              {STATUS_LABEL[q.status]}
                            </Badge>
                            <span className='truncate'>{q.name}</span>
                            <span className='text-muted-foreground shrink-0'>
                              {q.chunks ? `${q.chunks} 块` : ''}
                              {q.ingestedChunks ? ` · 入库 ${q.ingestedChunks}` : ''}
                            </span>
                          </div>
                          <div className='flex shrink-0 items-center gap-1'>
                            {q.note ? (
                              <span className='text-muted-foreground max-w-[14rem] truncate' title={q.note}>
                                {q.note}
                              </span>
                            ) : null}
                            {q.status !== 'ingesting' ? (
                              <Button
                                size='sm'
                                variant='ghost'
                                disabled={busy}
                                onClick={() => removeFromQueue(q.id)}
                              >
                                移除
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {queue.length === 0 && (
                <div className='flex flex-col gap-1.5'>
                  <Label>或直接粘贴内容</Label>
                  <textarea
                    rows={5}
                    value={text}
                    onChange={handleTextChange}
                    placeholder='粘贴文档正文…'
                    className='border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[80px] w-full rounded-md border px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none'
                  />
                </div>
              )}

              {!batch && (
                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='kb-title-new'>文档标题</Label>
                  <Input id='kb-title-new' value={title} onChange={(e) => setTitle(e.target.value)} placeholder='例如：平台运维手册 v2' />
                </div>
              )}

              {shownChunks > 0 && (
                <div className='rounded-lg border p-3'>
                  <div className='mb-1.5 flex items-center justify-between text-xs'>
                    <span className='text-muted-foreground'>
                      预计 {shownChunks} 块 · ~{shownTokens.toLocaleString()} tokens
                    </span>
                    <span className={projectedPct > 90 ? 'font-semibold text-destructive' : 'text-muted-foreground'}>
                      摄取后额度占用 {projectedPct}%
                    </span>
                  </div>
                  <Progress value={Math.min(projectedPct, 100)} className='h-1.5' />
                </div>
              )}

              {!batch && chunks.length > 0 && (
                <div>
                  <div className='mb-1.5 flex items-center gap-2'>
                    <span className='text-xs font-medium'>分块预览</span>
                    <Badge variant='secondary' className='text-xs'>{chunks.length} 块</Badge>
                  </div>
                  <ScrollArea className='h-48 rounded-md border'>
                    <div className='flex flex-col gap-2 p-2'>
                      {chunks.map((c, i) => (
                        <div key={i} className='rounded-md bg-muted/50 p-2 text-xs'>
                          <div className='mb-1 flex items-center gap-1.5 text-muted-foreground'>
                            <Badge variant='outline' className='py-0 text-[10px]'>#{i + 1}</Badge>
                            <span>{c.length} 字 · ~{Math.ceil(c.length / CHARS_PER_TOKEN)} tokens</span>
                          </div>
                          <p className='line-clamp-3 leading-relaxed text-foreground'>{c}</p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {error && <p className='text-sm text-destructive'>{error}</p>}
            </div>

            <DialogFooter>
              <Button variant='outline' onClick={() => close(false)} disabled={busy}>
                取消
              </Button>
              <Button
                disabled={busy || (batch ? pending.length === 0 : !title || !text)}
                onClick={submit}
              >
                {busy
                  ? batch
                    ? '摄取中…'
                    : '摄取中…'
                  : batch
                    ? `摄取 ${pending.length} 篇`
                    : '摄取 ' + chunks.length + ' 块'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
