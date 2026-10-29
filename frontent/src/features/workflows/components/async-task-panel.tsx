'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';

interface PlatformJob {
  job_id: string;
  job_type: string;
  status: string;
  request_id: string;
  trace_id: string;
  scope: string;
  attempts?: string | number;
  error_code?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
  last_attempt_at?: string;
  last_retry_at?: string;
  finished_at?: string;
  result?: Record<string, unknown> | null;
}

const activeStatuses = new Set(['QUEUED', 'RUNNING', 'RETRY_WAITING']);

const statusMeta: Record<string, { label: string; className: string }> = {
  QUEUED: { label: '排队中', className: 'border-blue-500/30 bg-blue-500/10 text-blue-400' },
  RUNNING: { label: '执行中', className: 'border-blue-500/30 bg-blue-500/10 text-blue-400' },
  RETRY_WAITING: { label: '等待重试', className: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  SUCCEEDED: { label: '已完成', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  FAILED: { label: '失败', className: 'border-red-500/30 bg-red-500/10 text-red-400' }
};

const formatTime = (iso?: string) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.valueOf()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
};

export function AsyncTaskPanel() {
  const [queryTaskId, setQueryTaskId] = useQueryState('task_id', parseAsString.withDefault(''));
  const [input, setInput] = useState(queryTaskId);
  const [job, setJob] = useState<PlatformJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/platform/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `任务查询失败（${response.status}）`);
      setJob(body.job || null);
    } catch (cause: unknown) {
      setJob(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!queryTaskId) return;
    const timer = window.setTimeout(() => void load(queryTaskId), 0);
    return () => window.clearTimeout(timer);
  }, [queryTaskId, load]);

  useEffect(() => {
    if (!queryTaskId || !job || !activeStatuses.has(job.status)) return;
    const timer = window.setInterval(() => void load(queryTaskId), 3000);
    return () => window.clearInterval(timer);
  }, [queryTaskId, job, load]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = input.trim();
    setInput(next);
    if (!next) {
      setJob(null);
      setError(null);
    }
    await setQueryTaskId(next || null);
    if (next === queryTaskId) void load(next);
  };

  const meta = job ? statusMeta[job.status] || { label: job.status, className: 'border-border text-foreground' } : null;
  const active = Boolean(job && activeStatuses.has(job.status));

  return (
    <section className='mt-5 border-t border-[#1F2937] pt-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-zinc-100'>异步任务</h3>
          <p className='mt-1 text-xs text-zinc-500'>查询 task_id 的队列、执行和最终结果。</p>
        </div>
        {active ? <span className='text-xs text-blue-400'>每 3 秒更新</span> : null}
      </div>

      <form className='mt-3 flex flex-col gap-2 sm:flex-row' onSubmit={submit}>
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder='输入 task_id'
          aria-label='task_id'
          className='border-[#1F2937] bg-[#111827] text-zinc-100 placeholder:text-zinc-600 sm:max-w-lg'
        />
        <Button type='submit' size='sm' variant='outline' disabled={!input.trim() || loading} className='border-[#1F2937] bg-[#111827] text-zinc-300'>
          <Icons.search />
          查询
        </Button>
        {job ? (
          <Button
            type='button'
            size='icon-sm'
            variant='outline'
            title='刷新任务状态'
            aria-label='刷新任务状态'
            onClick={() => void load(job.job_id)}
            disabled={loading}
            className='border-[#1F2937] bg-[#111827] text-zinc-300'
          >
            <Icons.refresh className={loading ? 'animate-spin' : undefined} />
          </Button>
        ) : null}
      </form>

      {loading && !job ? <Skeleton className='mt-4 h-28 w-full bg-[#111827]' /> : null}
      {error ? <p className='mt-3 text-sm text-red-400'>{error}</p> : null}
      {!queryTaskId && !error ? <p className='mt-3 text-xs text-zinc-600'>输入异步入口返回的 task_id 后查看状态。</p> : null}

      {job ? (
        <div className='mt-4 border border-[#1F2937] bg-[#111827]/70 p-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <div className='font-mono text-xs text-zinc-300'>{job.job_id}</div>
            <Badge className={meta?.className}>{meta?.label}</Badge>
          </div>
          <div className='mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4'>
            <Detail label='类型' value={job.job_type} />
            <Detail label='尝试次数' value={String(job.attempts ?? '0')} />
            <Detail label='更新时间' value={formatTime(job.updated_at)} />
            <Detail label='完成时间' value={formatTime(job.finished_at)} />
          </div>
          <div className='mt-3 grid gap-2 text-xs sm:grid-cols-2'>
            <CopyValue label='request_id' value={job.request_id} />
            <CopyValue label='trace_id' value={job.trace_id} />
          </div>
          {job.error_message ? <p className='mt-3 text-xs text-red-400'>{job.error_code || '任务失败'}：{job.error_message}</p> : null}
          {job.result ? (
            <pre className='mt-3 max-h-40 overflow-auto border border-[#1F2937] bg-[#0B1220] p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-400'>
              {JSON.stringify(job.result, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <div className='text-zinc-600'>{label}</div>
      <div className='truncate text-zinc-300' title={value}>{value}</div>
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <div className='text-zinc-600'>{label}</div>
      <div className='truncate font-mono text-[11px] text-zinc-400' title={value}>{value || '—'}</div>
    </div>
  );
}
