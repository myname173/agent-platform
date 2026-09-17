'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';

interface Todo {
  id: number;
  text: string;
  due_date?: string;
  overdue?: boolean;
  due_today?: boolean;
  owner_ref?: string;
  owner_name?: string;
}

interface Person {
  name: string;
  display_name: string;
  role: string;
}

export function TodosCard() {
  const [open, setOpen] = useState<Todo[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [owner, setOwner] = useState<string>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = owner === 'all' ? '' : '?owner=' + encodeURIComponent(owner);
      const r = await fetch('/api/n8n/todos' + q, { cache: 'no-store' });
      const j = await r.json();
      setOpen(j.open || []);
      if (Array.isArray(j.people)) setPeople(j.people);
    } catch (e) {
      /* ignore */
    }
  }, [owner]);

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
        <CardDescription>开放循环登记：对话里说「记一下」新增，说「派给某人」指派，这里或对话里说「办完了」收口。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-2 text-sm'>
        <div className='flex items-center gap-2'>
          <span className='text-muted-foreground shrink-0'>负责人</span>
          <Select value={owner} onValueChange={(v) => setOwner(v ?? 'all')}>
            <SelectTrigger className='h-8 w-[180px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部</SelectItem>
              <SelectItem value='mine'>我自己（未指派）</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.display_name || p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {open.length === 0 ? (
          <span className='text-muted-foreground'>暂无待办。</span>
        ) : (
          open.map((t) => (
            <div key={t.id} className='flex items-center justify-between gap-3 border-b border-dashed pb-2 last:border-0 last:pb-0'>
              <div className='flex min-w-0 flex-wrap items-center gap-2'>
                <span className='truncate'>{t.text}</span>
                {t.owner_ref ? (
                  <Badge variant='secondary' className='shrink-0 font-normal'>
                    {t.owner_name || t.owner_ref}
                  </Badge>
                ) : (
                  <Badge variant='outline' className='text-muted-foreground shrink-0 font-normal'>
                    我
                  </Badge>
                )}
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
