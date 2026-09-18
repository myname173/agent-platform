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

interface Reminder {
  id: number;
  text: string;
  owner_ref?: string;
  owner_name?: string;
  due_at: string;
  due_local: string;
  status: string;
  delivered: string;
  attempts: number;
}

interface Person {
  name: string;
  display_name: string;
}

const STATUS_LABEL: Record<string, string> = {
  sent: '已触发',
  canceled: '已取消',
  failed: '投递失败',
  pending: '待触发'
};

export function RemindersCard() {
  const [pending, setPending] = useState<Reminder[]>([]);
  const [recent, setRecent] = useState<Reminder[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [owner, setOwner] = useState<string>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = owner === 'all' ? '' : '?owner=' + encodeURIComponent(owner);
      const r = await fetch('/api/n8n/reminders' + q, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setMsg((j && (j.error || j.reason)) || '加载失败');
        return;
      }
      setPending(j.pending || []);
      setRecent(j.recent || []);
      if (Array.isArray(j.people)) setPeople(j.people);
      setMsg(null);
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    }
  }, [owner]);

  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (id: number) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch('/api/n8n/reminders/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || (j && j.ok === false)) setMsg((j && (j.error || j.reason)) || '取消失败');
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
        <CardTitle>提醒</CardTitle>
        <CardDescription>
          到点通过统一出口推送。可以指派给别人——对方没有直达通道时，投递会回落给机主而不是静默丢弃。
        </CardDescription>
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

        {pending.length === 0 ? (
          <span className='text-muted-foreground'>暂无待触发的提醒。</span>
        ) : (
          pending.map((t) => (
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
                <Badge variant='outline' className='shrink-0 font-normal'>
                  {t.due_local || t.due_at}
                </Badge>
              </div>
              <Button size='sm' variant='outline' disabled={busy === t.id} onClick={() => cancel(t.id)} className='shrink-0'>
                {busy === t.id ? '…' : '取消'}
              </Button>
            </div>
          ))
        )}

        {recent.length ? (
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-xs'>最近</span>
            {recent.slice(0, 4).map((t) => (
              <div key={t.id} className='text-muted-foreground flex items-center gap-2 text-xs'>
                <Badge variant='outline' className='shrink-0 font-normal'>
                  {STATUS_LABEL[t.status] || t.status}
                </Badge>
                <span className='truncate'>{t.text}</span>
                {t.owner_ref ? <span className='shrink-0'>→ {t.owner_name || t.owner_ref}</span> : null}
                {t.delivered && t.delivered !== 'ok' ? <span className='shrink-0'>（{t.delivered}）</span> : null}
              </div>
            ))}
          </div>
        ) : null}

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
