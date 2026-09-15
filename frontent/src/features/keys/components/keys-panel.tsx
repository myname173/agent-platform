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

interface ManagedKey {
  id: string;
  name: string;
  enabled: boolean;
  rate_limit_rpm: number;
  budget_daily_usd: number;
  budget_monthly_usd: number;
  spend_24h: number;
  spend_30d: number;
  total_cost: number;
  fingerprint: string;
  created_at: string;
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

const fmtUsd = (v: number) => '$' + Number(v || 0).toFixed(4);
const fmtBudget = (v: number) => (Number(v || 0) === 0 ? '不限' : fmtUsd(v));

const errText = (body: any): string => {
  if (!body) return '请求失败';
  return body?.error?.message || body?.error?.code || body?.error?.type || '请求失败';
};

export function KeysPanel() {
  const [keys, setKeys] = useState<ManagedKey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/keys', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      setKeys(j.keys || []);
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
        const res = await fetch('/api/n8n/keys', {
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
      <div className='flex items-center justify-between'>
        <div className='text-muted-foreground text-sm'>
          托管 Key 用于给不同客户端签发独立凭据（限流、预算、可吊销）。预算为滚动窗口，超限请求会被网关拒绝（429）。
        </div>
        <CreateKeyDialog onCreated={load} />
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
          <CardTitle>API Keys</CardTitle>
          <CardDescription>{keys ? `${keys.length} 个托管 Key` : '加载中…'}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className='text-destructive text-sm'>加载失败：{loadError}</p>
          ) : keys === null ? (
            <div className='flex flex-col gap-2'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : keys.length === 0 ? (
            <p className='text-muted-foreground text-sm'>暂无托管 Key —— 用右上角「签发新 Key」创建第一个。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>限流 (rpm)</TableHead>
                  <TableHead>预算（日 / 月）</TableHead>
                  <TableHead>滚动已用</TableHead>
                  <TableHead>累计成本</TableHead>
                  <TableHead>指纹</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id || k.name}>
                    <TableCell className='font-medium'>{k.name}</TableCell>
                    <TableCell>
                      <Badge variant={k.enabled ? 'default' : 'outline'}>{k.enabled ? '启用' : '已停用'}</Badge>
                    </TableCell>
                    <TableCell className='tabular-nums'>{k.rate_limit_rpm === 0 ? '不限' : k.rate_limit_rpm}</TableCell>
                    <TableCell className='tabular-nums text-xs'>
                      {fmtBudget(k.budget_daily_usd)} / {fmtBudget(k.budget_monthly_usd)}
                    </TableCell>
                    <TableCell className='text-muted-foreground tabular-nums text-xs'>
                      24h {fmtUsd(k.spend_24h)} · 30d {fmtUsd(k.spend_30d)}
                    </TableCell>
                    <TableCell className='tabular-nums'>{fmtUsd(k.total_cost)}</TableCell>
                    <TableCell className='text-muted-foreground font-mono text-xs'>{k.fingerprint}…</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{fmtTime(k.created_at)}</TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith(k.name)}
                          onClick={() => act(k.enabled ? 'disable' : 'enable', k.name)}
                        >
                          {k.enabled ? '停用' : '启用'}
                        </Button>
                        <SetLimitDialog name={k.name} current={k.rate_limit_rpm} onDone={load} />
                        <BudgetDialog name={k.name} daily={k.budget_daily_usd} monthly={k.budget_monthly_usd} onDone={load} />
                        <DeleteKeyButton name={k.name} onDone={load} />
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

function CreateKeyDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rpm, setRpm] = useState('0');
  const [busy, setBusy] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/n8n/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name, rate_limit_rpm: Number(rpm || 0) })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(errText(body));
        return;
      }
      setRawKey(body.raw_key);
      onCreated();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!rawKey) return;
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setName('');
      setRpm('0');
      setRawKey(null);
      setError(null);
      setCopied(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<Button />}>签发新 Key</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        {rawKey ? (
          <>
            <DialogHeader>
              <DialogTitle>Key 已创建（只显示这一次）</DialogTitle>
              <DialogDescription>请立即复制并妥善保存——服务端只存哈希，关闭后无法再次查看。</DialogDescription>
            </DialogHeader>
            <div className='bg-muted flex items-center gap-2 rounded-md border p-3'>
              <code className='flex-1 overflow-x-auto font-mono text-xs'>{rawKey}</code>
              <Button size='sm' variant='outline' onClick={copy}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>签发新 Key</DialogTitle>
              <DialogDescription>为客户端创建一个托管 Key（可随时停用/吊销/设预算）。</DialogDescription>
            </DialogHeader>
            <div className='flex flex-col gap-3'>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='key-name'>名称</Label>
                <Input id='key-name' value={name} onChange={(e) => setName(e.target.value)} placeholder='例如：phone / laptop / team-a' />
              </div>
              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='key-rpm'>限流 rpm（0 = 不限）</Label>
                <Input id='key-rpm' type='number' min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} />
              </div>
              {error ? <p className='text-destructive text-sm'>{error}</p> : null}
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => close(false)}>
                取消
              </Button>
              <Button disabled={busy || !name} onClick={submit}>
                创建
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------- set limit ---------- */

function SetLimitDialog({ name, current, onDone }: { name: string; current: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rpm, setRpm] = useState(String(current));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await fetch('/api/n8n/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_limit', name, rate_limit_rpm: Number(rpm || 0) })
      });
      onDone();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size='sm' variant='outline' />}>限额</DialogTrigger>
      <DialogContent className='sm:max-w-xs'>
        <DialogHeader>
          <DialogTitle>调整限额 · {name}</DialogTitle>
          <DialogDescription>每分钟请求数上限（0 = 不限）。</DialogDescription>
        </DialogHeader>
        <Input type='number' min={0} value={rpm} onChange={(e) => setRpm(e.target.value)} />
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

/* ---------- budget ---------- */

function BudgetDialog({ name, daily, monthly, onDone }: { name: string; daily: number; monthly: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(String(daily));
  const [m, setM] = useState(String(monthly));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await fetch('/api/n8n/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_budget', name, budget_daily_usd: Number(d || 0), budget_monthly_usd: Number(m || 0) })
      });
      onDone();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size='sm' variant='outline' />}>预算</DialogTrigger>
      <DialogContent className='sm:max-w-xs'>
        <DialogHeader>
          <DialogTitle>预算硬限 · {name}</DialogTitle>
          <DialogDescription>滚动窗口花费上限（USD，0 = 不限）。超限请求将被网关拒绝。</DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1.5'>
            <Label>日预算（滚动 24 小时）</Label>
            <Input type='number' min={0} step='0.01' value={d} onChange={(e) => setD(e.target.value)} />
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label>月预算（滚动 30 天）</Label>
            <Input type='number' min={0} step='0.1' value={m} onChange={(e) => setM(e.target.value)} />
          </div>
        </div>
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

function DeleteKeyButton({ name, onDone }: { name: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const doDelete = async () => {
    setBusy(true);
    try {
      await fetch('/api/n8n/keys', {
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
