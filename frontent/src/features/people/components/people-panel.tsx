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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Person {
  id: string;
  name: string;
  display_name: string;
  role: string;
  channels: string;
  tz: string;
  active: boolean;
  note: string;
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: '机主',
  member: '成员',
  guest: '外部'
};

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

const CHANNEL_LABEL: Record<string, string> = {
  telegram_chat_id: 'TG',
  webhook_url: 'Webhook',
  email: '邮件'
};

function ChannelChips({ raw }: { raw: string }) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return <span className='text-destructive text-xs'>通道 JSON 非法</span>;
  }
  const entries = Object.entries(parsed).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  if (!entries.length) {
    return (
      <Badge variant='outline' className='text-amber-600 dark:text-amber-400'>
        无通道 · 将回落机主
      </Badge>
    );
  }
  return (
    <div className='flex flex-wrap gap-1'>
      {entries.map(([k, v]) => (
        <Badge key={k} variant='secondary' className='font-mono text-[11px]'>
          {CHANNEL_LABEL[k] || k}: {String(v)}
        </Badge>
      ))}
    </div>
  );
}

const errText = (body: any): string => {
  if (!body) return '请求失败';
  return body?.error?.message || body?.error?.code || body?.error?.type || '请求失败';
};

export function PeoplePanel() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/people', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      setPeople(j.people || []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (action: string, name: string, extra?: Record<string, unknown>) => {
      setBusy(name + ':' + action);
      setFlash(null);
      try {
        const res = await fetch('/api/n8n/people', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, name, ...extra })
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          setFlash({ kind: 'err', text: errText(body) });
          return null;
        }
        setFlash({ kind: 'ok', text: `${action} 成功：${name}` });
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

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='flex items-center justify-between gap-4'>
        <div className='text-muted-foreground text-sm'>
          人员目录是派发与催办的地基：待办、提醒、周报都会按这里的「人」归属。条目由机主手动录入，<b>不开放自助注册</b>；没有通道的人，投递会自动回落给机主而不是静默丢弃。
        </div>
        <CreatePersonDialog onCreated={load} />
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
          <CardTitle>人员目录</CardTitle>
          <CardDescription>{people ? `${people.length} 人` : '加载中…'}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className='text-destructive text-sm'>加载失败：{loadError}</p>
          ) : people === null ? (
            <div className='flex flex-col gap-2'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : people.length === 0 ? (
            <p className='text-muted-foreground text-sm'>暂无人员 —— 用右上角「新增人员」录入第一个（建议先把自己登记为 owner）。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>投递通道</TableHead>
                  <TableHead>时区</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((p) => (
                  <TableRow key={p.id || p.name}>
                    <TableCell>
                      <div className='font-medium'>{p.display_name || p.name}</div>
                      <div className='text-muted-foreground font-mono text-xs'>@{p.name}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.role === 'owner' ? 'default' : 'outline'}>
                        {ROLE_LABEL[p.role] || p.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ChannelChips raw={p.channels} />
                    </TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{p.tz}</TableCell>
                    <TableCell>
                      <Badge variant={p.active ? 'default' : 'outline'}>{p.active ? '启用' : '停用'}</Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground max-w-[160px] truncate text-xs'>{p.note || '—'}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{fmtTime(p.created_at)}</TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith(p.name)}
                          onClick={() => act('toggle', p.name)}
                        >
                          {p.active ? '停用' : '启用'}
                        </Button>
                        <EditPersonDialog person={p} onDone={load} />
                        <DeletePersonButton name={p.name} role={p.role} onDone={load} />
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

/* ---------- create ---------- */

function PersonFields({
  name,
  setName,
  displayName,
  setDisplayName,
  role,
  setRole,
  channels,
  setChannels,
  tz,
  setTz,
  note,
  setNote,
  nameDisabled
}: {
  name: string;
  setName: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  role: string;
  setRole: (v: string | null) => void;
  channels: string;
  setChannels: (v: string) => void;
  tz: string;
  setTz: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  nameDisabled?: boolean;
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1.5'>
        <Label>标识（用于 @派发）</Label>
        <Input
          value={name}
          disabled={nameDisabled}
          onChange={(e) => setName(e.target.value)}
          placeholder='例如：张伟 / zhangwei'
        />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>展示名</Label>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder='留空则同标识' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>角色</Label>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='owner'>机主</SelectItem>
            <SelectItem value='member'>成员</SelectItem>
            <SelectItem value='guest'>外部</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>投递通道（JSON）</Label>
        <Input
          className='font-mono text-xs'
          value={channels}
          onChange={(e) => setChannels(e.target.value)}
          placeholder='{"telegram_chat_id":"123456"}'
        />
        <p className='text-muted-foreground text-xs'>留空 = 无直达通道，投递时回落给机主。</p>
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>时区</Label>
        <Input value={tz} onChange={(e) => setTz(e.target.value)} placeholder='Asia/Shanghai' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>备注</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder='例如：行政 / 后端' />
      </div>
    </div>
  );
}

function CreatePersonDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('member');
  const [channels, setChannels] = useState('');
  const [tz, setTz] = useState('Asia/Shanghai');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/n8n/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          display_name: displayName,
          role,
          channels,
          tz,
          note,
          active: true
        })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(errText(body));
        return;
      }
      onCreated();
      setOpen(false);
      setName('');
      setDisplayName('');
      setRole('member');
      setChannels('');
      setTz('Asia/Shanghai');
      setNote('');
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>新增人员</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>新增人员</DialogTitle>
          <DialogDescription>录入后即可作为待办 / 提醒 / 周报的归属对象。</DialogDescription>
        </DialogHeader>
        <PersonFields
          name={name}
          setName={setName}
          displayName={displayName}
          setDisplayName={setDisplayName}
          role={role}
          setRole={(v) => setRole(v ?? 'member')}
          channels={channels}
          setChannels={setChannels}
          tz={tz}
          setTz={setTz}
          note={note}
          setNote={setNote}
        />
        {error ? <p className='text-destructive text-sm'>{error}</p> : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={busy || !name} onClick={submit}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- edit ---------- */

function EditPersonDialog({ person, onDone }: { person: Person; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(person.display_name || '');
  const [role, setRole] = useState(person.role || 'member');
  const [channels, setChannels] = useState(person.channels || '');
  const [tz, setTz] = useState(person.tz || 'Asia/Shanghai');
  const [note, setNote] = useState(person.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/n8n/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', name: person.name, display_name: displayName, role, channels, tz, note })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(errText(body));
        return;
      }
      onDone();
      setOpen(false);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size='sm' variant='outline' />}>编辑</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>编辑 · {person.display_name || person.name}</DialogTitle>
          <DialogDescription>标识不可修改（它是派发时的锚点）。</DialogDescription>
        </DialogHeader>
        <PersonFields
          name={person.name}
          setName={() => undefined}
          nameDisabled
          displayName={displayName}
          setDisplayName={setDisplayName}
          role={role}
          setRole={(v) => setRole(v ?? 'member')}
          channels={channels}
          setChannels={setChannels}
          tz={tz}
          setTz={setTz}
          note={note}
          setNote={setNote}
        />
        {error ? <p className='text-destructive text-sm'>{error}</p> : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- delete ---------- */

function DeletePersonButton({ name, role, onDone }: { name: string; role: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (role === 'owner') {
    return (
      <Button size='sm' variant='outline' disabled title='机主条目不可删除'>
        删除
      </Button>
    );
  }

  const doDelete = async () => {
    setBusy(true);
    try {
      await fetch('/api/n8n/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', name })
      });
      onDone();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <Button size='sm' variant='outline' className='text-destructive' onClick={() => setConfirming(true)}>
        删除
      </Button>
    );
  }
  return (
    <Button size='sm' variant='destructive' disabled={busy} onClick={doDelete}>
      确认删除?
    </Button>
  );
}
