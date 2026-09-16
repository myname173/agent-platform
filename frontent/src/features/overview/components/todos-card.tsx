'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Todo {
  id: number;
  text: string;
  due_date?: string;
  overdue?: boolean;
  due_today?: boolean;
}

export function TodosCard() {
  const [open, setOpen] = useState<Todo[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/todos', { cache: 'no-store' });
      const j = await r.json();
      setOpen(j.open || []);
    } catch (e) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const complete = async (id: number) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch('/api/n8n/todos/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || (j && j.ok === false)) setMsg((j && (j.error || j.reason)) || '操作失败');
      await load();
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>待办</CardTitle>
        <CardDescription>开放循环登记：对话里说「记一下」新增，这里或对话里说「办完了」收口。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-2 text-sm'>
        {open.length === 0 ? (
          <span className='text-muted-foreground'>暂无待办。</span>
        ) : (
          open.map((t) => (
            <div key={t.id} className='flex items-center justify-between gap-3 border-b border-dashed pb-2 last:border-0 last:pb-0'>
              <div className='flex min-w-0 items-center gap-2'>
                <span className='truncate'>{t.text}</span>
                {t.due_date ? (
                  <Badge variant={t.overdue ? 'destructive' : 'outline'} className='shrink-0 font-normal'>
                    {t.overdue ? '逾期 ' : t.due_today ? '今天 ' : ''}
                    {t.due_date}
                  </Badge>
                ) : null}
              </div>
              <Button size='sm' variant='outline' disabled={busy === t.id} onClick={() => complete(t.id)} className='shrink-0'>
                {busy === t.id ? '…' : '完成'}
              </Button>
            </div>
          ))
        )}
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
