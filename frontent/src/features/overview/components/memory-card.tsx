'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface MineMem {
  id: number;
  text: string;
  category?: string;
  source?: string;
  created_at?: string;
}

interface LobeMem {
  title?: string;
  summary?: string;
  category?: string;
  created_at?: string;
}

const fmt = (iso?: string) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
};

export function MemoryCard() {
  const [mine, setMine] = useState<MineMem[]>([]);
  const [lobe, setLobe] = useState<LobeMem[]>([]);
  const [counts, setCounts] = useState<{ mine?: number; lobe?: number }>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/memory', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setMsg((j && (j.error || j.reason)) || '加载失败');
        return;
      }
      setMine(j.mine || []);
      setLobe(j.lobe || []);
      setCounts(j.counts || {});
      setMsg(null);
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>记忆</CardTitle>
        <CardDescription>它记住的东西（只读）：平台记忆（TG 对话提取）+ LobeHub 自动提取。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        <div className='flex items-center gap-2'>
          <Badge variant='outline'>平台记忆 {counts.mine ?? mine.length}</Badge>
          <Badge variant='outline'>LobeHub {counts.lobe ?? lobe.length}</Badge>
        </div>
        <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
          <div className='flex flex-col gap-2'>
            <span className='text-muted-foreground text-xs'>平台记忆（agent_memories）</span>
            {mine.length === 0 ? (
              <span className='text-muted-foreground'>暂无——在 TG 对话里聊点稳定偏好试试。</span>
            ) : (
              mine.slice(0, 8).map((m) => (
                <div key={m.id} className='border-b border-dashed pb-2 last:border-0 last:pb-0'>
                  <span>{m.text}</span>
                  <div className='text-muted-foreground mt-1 text-xs'>
                    {[m.category, m.source, fmt(m.created_at)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className='flex flex-col gap-2'>
            <span className='text-muted-foreground text-xs'>LobeHub 记忆（user_memories）</span>
            {lobe.length === 0 ? (
              <span className='text-muted-foreground'>暂无。</span>
            ) : (
              lobe.slice(0, 8).map((m, i) => (
                <div key={i} className='border-b border-dashed pb-2 last:border-0 last:pb-0'>
                  <span className='font-medium'>{m.title || '记忆'}</span>
                  <div className='text-muted-foreground line-clamp-2 text-xs'>{m.summary}</div>
                  <div className='text-muted-foreground mt-1 text-xs'>
                    {[m.category, fmt(m.created_at)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        {msg ? <span className='text-muted-foreground'>{msg}</span> : null}
        <div className='flex justify-end'>
          <Button size='sm' variant='ghost' onClick={load}>
            刷新
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
