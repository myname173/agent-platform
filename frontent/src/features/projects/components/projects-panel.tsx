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

interface Project {
  id: string;
  name: string;
  label: string;
  repo_url: string;
  customer: string;
  status: string;
  notes: string;
  created_at: string;
  open_todos: number;
  overdue_todos: number;
  due_today_todos: number;
  docs: number;
}

interface ProjectList {
  ok: boolean;
  count: number;
  projects: Project[];
  today: string;
  unattached: { open_todos: number; docs: number };
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

const errText = (body: any): string => {
  if (!body) return '请求失败';
  return body?.error?.message || body?.error?.code || body?.error?.type || '请求失败';
};

function WorkCounts({ p }: { p: Project }) {
  if (!p.open_todos) {
    return <span className='text-muted-foreground text-xs'>—</span>;
  }
  return (
    <div className='flex flex-wrap gap-1'>
      <Badge variant='outline'>{p.open_todos} 未完成</Badge>
      {p.overdue_todos ? (
        <Badge className='bg-destructive/15 text-destructive' variant='outline'>
          {p.overdue_todos} 逾期
        </Badge>
      ) : null}
      {p.due_today_todos ? (
        <Badge variant='secondary'>今日 {p.due_today_todos}</Badge>
      ) : null}
    </div>
  );
}

export function ProjectsPanel() {
  const [data, setData] = useState<ProjectList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/projects', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      setData(await res.json());
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
        const res = await fetch('/api/n8n/projects', {
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

  const projects = data?.projects ?? null;

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='flex items-center justify-between gap-4'>
        <div className='text-muted-foreground text-sm'>
          项目登记表是「这活儿是给谁做的」的唯一事实源：待办、文档与对外验收报告都按这里的 <b>slug</b> 归属，晨报会把项目渲染成行尾标签。slug 建后<b>不可改</b>（改了就会孤立所有引用它的记录）；不再推进的项目请<b>归档</b>而不是删除。
        </div>
        <CreateProjectDialog onCreated={load} />
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
          <CardTitle>项目</CardTitle>
          <CardDescription>
            {data
              ? `${data.count} 个项目 · 未归类待办 ${data.unattached.open_todos} 条 / 未归类文档 ${data.unattached.docs} 份`
              : '加载中…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className='text-destructive text-sm'>加载失败：{loadError}</p>
          ) : projects === null ? (
            <div className='flex flex-col gap-2'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              暂无项目 —— 用右上角「新增项目」登记第一个，或跑一次{' '}
              <code className='font-mono text-xs'>node n8n/scripts/seed-projects.mjs apply</code>。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>待办</TableHead>
                  <TableHead>文档</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className='text-right'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow key={p.id || p.name}>
                    <TableCell>
                      <div className='font-medium'>{p.label || p.name}</div>
                      <div className='text-muted-foreground font-mono text-xs'>{p.name}</div>
                      {p.repo_url ? (
                        <a
                          className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline'
                          href={p.repo_url}
                          target='_blank'
                          rel='noreferrer noopener'
                        >
                          仓库
                        </a>
                      ) : null}
                    </TableCell>
                    <TableCell className='text-xs'>{p.customer || '—'}</TableCell>
                    <TableCell>
                      <WorkCounts p={p} />
                    </TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{p.docs || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === 'active' ? 'default' : 'outline'}>
                        {p.status === 'active' ? '推进中' : '已归档'}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground max-w-[200px] truncate text-xs'>{p.notes || '—'}</TableCell>
                    <TableCell className='text-muted-foreground text-xs'>{fmtTime(p.created_at)}</TableCell>
                    <TableCell className='text-right'>
                      <div className='flex justify-end gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={busy.startsWith(p.name)}
                          onClick={() => act('archive', p.name)}
                        >
                          {p.status === 'active' ? '归档' : '恢复'}
                        </Button>
                        <EditProjectDialog project={p} onDone={load} />
                        <DeleteProjectButton project={p} busy={busy.startsWith(p.name + ':delete')} onDone={act} />
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

/* ---------- create / edit ---------- */

function ProjectFields({
  name,
  setName,
  label,
  setLabel,
  repoUrl,
  setRepoUrl,
  customer,
  setCustomer,
  notes,
  setNotes,
  nameDisabled
}: {
  name: string;
  setName: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  customer: string;
  setCustomer: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  nameDisabled?: boolean;
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1.5'>
        <Label>slug（待办 / 文档 / 报告都按它归属）</Label>
        <Input
          className='font-mono text-xs'
          value={name}
          disabled={nameDisabled}
          onChange={(e) => setName(e.target.value)}
          placeholder='例如：xiangshu'
        />
        <p className='text-muted-foreground text-xs'>1-48 个字符，仅限字母、数字与 _ . -（要进查询串和工具参数）。</p>
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>显示名</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder='留空则同 slug，例如：项述' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>仓库地址</Label>
        <Input
          className='font-mono text-xs'
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder='https://github.com/…'
        />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>客户 / 甲方</Label>
        <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder='内部项目可留空' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label>备注</Label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='例如：一句话说明这个项目在做什么' />
      </div>
    </div>
  );
}

function useProjectForm(initial?: Partial<Project>) {
  const [name, setName] = useState(initial?.name ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [repoUrl, setRepoUrl] = useState(initial?.repo_url ?? '');
  const [customer, setCustomer] = useState(initial?.customer ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { name, setName, label, setLabel, repoUrl, setRepoUrl, customer, setCustomer, notes, setNotes, busy, setBusy, error, setError };
}

function CreateProjectDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const f = useProjectForm();

  const submit = async () => {
    f.setBusy(true);
    f.setError(null);
    try {
      const res = await fetch('/api/n8n/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name: f.name,
          label: f.label,
          repo_url: f.repoUrl,
          customer: f.customer,
          notes: f.notes
        })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        f.setError(errText(body));
        return;
      }
      onCreated();
      setOpen(false);
    } catch (e: any) {
      f.setError(String(e?.message || e));
    } finally {
      f.setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>新增项目</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>新增项目</DialogTitle>
          <DialogDescription>登记后即可作为待办、文档与验收报告的归属对象。</DialogDescription>
        </DialogHeader>
        <ProjectFields
          name={f.name}
          setName={f.setName}
          label={f.label}
          setLabel={f.setLabel}
          repoUrl={f.repoUrl}
          setRepoUrl={f.setRepoUrl}
          customer={f.customer}
          setCustomer={f.setCustomer}
          notes={f.notes}
          setNotes={f.setNotes}
        />
        {f.error ? <p className='text-destructive text-sm'>{f.error}</p> : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={f.busy || !f.name} onClick={submit}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({ project, onDone }: { project: Project; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const f = useProjectForm(project);

  const submit = async () => {
    f.setBusy(true);
    f.setError(null);
    try {
      const res = await fetch('/api/n8n/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          name: project.name,
          label: f.label,
          repo_url: f.repoUrl,
          customer: f.customer,
          notes: f.notes
        })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        f.setError(errText(body));
        return;
      }
      onDone();
      setOpen(false);
    } catch (e: any) {
      f.setError(String(e?.message || e));
    } finally {
      f.setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size='sm' variant='outline' />}>编辑</DialogTrigger>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>编辑 · {project.label || project.name}</DialogTitle>
          <DialogDescription>slug 不可修改（它是所有 project_ref 的锚点）。</DialogDescription>
        </DialogHeader>
        <ProjectFields
          name={project.name}
          setName={() => undefined}
          nameDisabled
          label={f.label}
          setLabel={f.setLabel}
          repoUrl={f.repoUrl}
          setRepoUrl={f.setRepoUrl}
          customer={f.customer}
          setCustomer={f.setCustomer}
          notes={f.notes}
          setNotes={f.setNotes}
        />
        {f.error ? <p className='text-destructive text-sm'>{f.error}</p> : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button disabled={f.busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- delete ---------- */

function DeleteProjectButton({
  project,
  busy,
  onDone
}: {
  project: Project;
  busy: boolean;
  onDone: (action: string, name: string) => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const referenced = project.open_todos > 0 || project.docs > 0;

  if (referenced) {
    return (
      <Button
        size='sm'
        variant='outline'
        disabled
        title={`仍有 ${project.open_todos} 条待办 / ${project.docs} 份文档指向它；请先归档`}
      >
        删除
      </Button>
    );
  }

  const doDelete = async () => {
    await onDone('delete', project.name);
    setConfirming(false);
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
