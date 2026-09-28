'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent } from '@/components/ui/card';
import type { KbSearchResult } from '@/lib/n8n-client';

// ─── quick-search chips ───────────────────────────────────────────────────────
const CHIPS = ['平台架构', '工作流自动化', '知识库', '待办提醒', '每日简报', '嵌入额度'];

// ─── helpers ─────────────────────────────────────────────────────────────────
function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls =
    pct >= 85
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : pct >= 65
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-muted-foreground/30 bg-muted text-muted-foreground';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${cls}`}>
      {pct}% 匹配
    </span>
  );
}

// ─── component ────────────────────────────────────────────────────────────────
export function KbSearchTester() {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(6);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [searched, setSearched] = useState('');
  const [error, setError] = useState<string | null>(null);

  const search = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSearched(trimmed);
    try {
      const res = await fetch('/api/n8n/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search', query: trimmed, top_k: topK }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error || '搜索失败');
        return;
      }
      setResults(body.results ?? []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') search(query);
  };

  return (
    <div className='flex flex-col gap-5'>
      {/* search bar */}
      <div className='flex gap-2'>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='输入查询语句，按 Enter 或点击搜索…'
          className='flex-1'
        />
        <Button onClick={() => search(query)} disabled={loading || !query.trim()}>
          {loading ? '检索中…' : '搜索'}
        </Button>
      </div>

      {/* top-K slider */}
      <div className='flex items-center gap-4'>
        <span className='text-muted-foreground min-w-[3rem] text-sm'>Top K</span>
        <Slider
          min={1}
          max={10}
          step={1}
          value={[topK]}
          onValueChange={(v) => {
            const next = Array.isArray(v) ? v[0] : typeof v === 'number' ? v : 6;
            setTopK(next);
          }}
          className='max-w-xs flex-1'
        />
        <span className='w-4 text-center text-sm font-semibold tabular-nums'>{topK}</span>
      </div>

      {/* quick chips */}
      <div className='flex flex-wrap gap-2'>
        {CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => {
              setQuery(chip);
              search(chip);
            }}
            className='bg-muted hover:bg-muted/70 text-muted-foreground rounded-full border px-3 py-1 text-xs transition-colors'
          >
            {chip}
          </button>
        ))}
      </div>

      {/* skeleton */}
      {loading && (
        <div className='flex flex-col gap-3'>
          {Array.from({ length: topK > 3 ? 3 : topK }).map((_, i) => (
            <Skeleton key={i} className='h-24 w-full rounded-xl' />
          ))}
        </div>
      )}

      {/* error */}
      {error && <p className='text-destructive text-sm'>❌ {error}</p>}

      {/* results */}
      {results !== null && !loading && (
        <div className='flex flex-col gap-3'>
          {results.length === 0 ? (
            <p className='text-muted-foreground py-6 text-center text-sm'>
              未找到相关内容 — 请尝试其他关键词或先摄取文档。
            </p>
          ) : (
            <>
              <div className='text-muted-foreground flex items-center justify-between text-xs'>
                <span>
                  「{searched}」 · 返回 {results.length} 条结果
                </span>
              </div>
              {results.map((r, i) => (
                <Card key={`${r.doc_id}-${r.seq}-${i}`} className='overflow-hidden'>
                  <CardContent className='p-4'>
                    <div className='mb-2 flex flex-wrap items-center gap-2'>
                      <span className='text-[11px] font-semibold text-muted-foreground tabular-nums'>
                        #{i + 1}
                      </span>
                      <ScoreBadge score={r.score} />
                      <Badge variant='outline' className='py-0 text-[10px]'>
                        {r.title}
                      </Badge>
                      <Badge variant='secondary' className='py-0 text-[10px]'>
                        块 #{r.seq + 1}
                      </Badge>
                    </div>
                    <p className='line-clamp-5 text-sm leading-relaxed'>{r.content}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>
      )}

      {results === null && !loading && !error && (
        <div className='text-muted-foreground rounded-xl border border-dashed py-12 text-center text-sm'>
          在上方输入查询，实时测试知识库的检索质量
        </div>
      )}
    </div>
  );
}
