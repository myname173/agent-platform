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

interface FileState {
  name: string;
  text: string;
}


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

export function KbIngestDialog({ onDone, usedTokens = 0 }: IngestDialogProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<FileState | null>(null);
  const [text, setText] = useState('');
  const [chunks, setChunks] = useState<string[]>([]);
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

  const handleFile = useCallback(
    async (f: File) => {
      setError(null);
      setBusy(true);
      try {
        const { text: raw, warning } = await extractFileText(f);
        if (warning) setError(warning);
        setFile({ name: f.name, text: raw });
        processText(raw, f.name);
      } catch (e: any) {
        setError('读取失败：' + String((e && e.message) || e));
      } finally {
        setBusy(false);
      }
    },
    [processText]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    processText(e.target.value);
  };

  const estTokens = estimateTokens(chunks);
  const projectedUsed = usedTokens + estTokens;
  const projectedPct = Math.round((projectedUsed / EMBED_QUOTA) * 100);

  const submit = async () => {
    if (!title || !text) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/n8n/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ingest', title, text }),
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
          (body.tokens_billed ?? estTokens) +
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
      setFile(null);
      setChunks([]);
      setError(null);
      setResult(null);
    }
  };

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
                拖放文本文件（.txt / .md）或粘贴内容，预览分块后再提交。
              </DialogDescription>
            </DialogHeader>

            <div className='flex flex-col gap-4'>
              <div
                className={
                  'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-sm transition-colors ' +
                  (dragging
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/60')
                }
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                {file ? (
                  <span className='font-medium'>
                    📄 {file.name} · {(file.text.length / 1000).toFixed(1)} KB
                  </span>
                ) : (
                  <span>点击或拖入 .txt / .md / .pdf / .docx 文件</span>
                )}
                <input ref={inputRef} type='file' accept='.txt,.md,.markdown,.pdf,.docx' className='hidden' onChange={onInputChange} />
              </div>

              {!file && (
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

              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='kb-title-new'>文档标题</Label>
                <Input id='kb-title-new' value={title} onChange={(e) => setTitle(e.target.value)} placeholder='例如：平台运维手册 v2' />
              </div>

              {chunks.length > 0 && (
                <div className='rounded-lg border p-3'>
                  <div className='mb-1.5 flex items-center justify-between text-xs'>
                    <span className='text-muted-foreground'>
                      预计 {chunks.length} 块 · ~{estTokens.toLocaleString()} tokens
                    </span>
                    <span className={projectedPct > 90 ? 'font-semibold text-destructive' : 'text-muted-foreground'}>
                      摄取后额度占用 {projectedPct}%
                    </span>
                  </div>
                  <Progress value={Math.min(projectedPct, 100)} className='h-1.5' />
                </div>
              )}

              {chunks.length > 0 && (
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
              <Button variant='outline' onClick={() => close(false)}>取消</Button>
              <Button disabled={busy || !title || !text} onClick={submit}>
                {busy ? '摄取中…' : '摄取 ' + chunks.length + ' 块'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
