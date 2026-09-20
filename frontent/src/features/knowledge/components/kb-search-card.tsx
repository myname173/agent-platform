'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { searchKb, type KbSearchResult } from '@/lib/n8n-client';

/**
 * 检索测试台：直接对知识库做一次语义检索，看命中的是哪几段、相似度多少。
 * 入库之后如果「搜不到」，这里是第一个能自查的地方 —— 不用等到模型侧才发现问题。
 */
export function KbSearchCard() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [took, setTook] = useState<number | null>(null);

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setResults(null);
    const t0 = Date.now();
    try {
      const r = await searchKb(q, 5);
      setResults(r.results || []);
      setTook(Date.now() - t0);
    } catch (e: any) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>检索测试</CardTitle>
        <CardDescription>
          对已入库内容做一次语义检索。看得到命中的段落与相似度，就能判断「是没入库，还是检索不准」。
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <div className='flex gap-2'>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) run(); }}
            placeholder='例如：续约率目标是多少'
          />
          <Button onClick={run} disabled={busy || !query.trim()} className='shrink-0'>
            {busy ? '检索中…' : '检索'}
          </Button>
        </div>

        {error ? <p className='text-destructive text-sm'>检索失败：{error}</p> : null}

        {results ? (
          results.length === 0 ? (
            <p className='text-muted-foreground text-sm'>没有命中任何段落。</p>
          ) : (
            <div className='flex flex-col gap-2'>
              <p className='text-muted-foreground text-xs'>
                命中 {results.length} 段 · 用时 {took} ms
              </p>
              {results.map((r) => (
                <div key={r.doc_id + '#' + r.seq} className='flex flex-col gap-1 border-b border-dashed pb-2 last:border-0 last:pb-0'>
                  <div className='flex items-center gap-2'>
                    <Badge variant={r.score >= 0.55 ? 'default' : 'outline'} className='shrink-0 font-normal tabular-nums'>
                      {r.score.toFixed(3)}
                    </Badge>
                    <span className='truncate text-sm font-medium'>{r.title}</span>
                    <span className='text-muted-foreground shrink-0 text-xs'>#{r.seq}</span>
                  </div>
                  <p className='text-muted-foreground line-clamp-3 text-xs'>{r.content}</p>
                </div>
              ))}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
