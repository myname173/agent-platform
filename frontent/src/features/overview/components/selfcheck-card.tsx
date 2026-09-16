'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Run {
  id?: number;
  source?: string;
  total?: number;
  passed?: number;
  failed?: number;
  warned?: number;
  duration_ms?: number;
  checked_at?: string;
  createdAt?: string;
  report?: string;
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
};

export function SelfcheckCard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/n8n/selfcheck', { cache: 'no-store' });
      const j = await r.json();
      setRuns(j.runs || []);
    } catch (e) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    setMsg('自检中…约 15–30 秒');
    try {
      const r = await fetch('/api/n8n/selfcheck', { method: 'POST' });
      const j = await r.json().catch(() => null);
      if (j && typeof j.passed === 'number') setMsg('完成：' + j.passed + '/' + j.total + ' 通过' + (j.failed ? '（' + j.failed + ' 项失败）' : ''));
      else setMsg((j && (j.error || j.reason)) || '失败（HTTP ' + r.status + '）');
      await load();
    } catch (e: any) {
      setMsg(String((e && e.message) || e));
    } finally {
      setRunning(false);
    }
  };

  const latest = runs[0];
  let failedNames: string[] = [];
  let warnNames: string[] = [];
  if (latest && latest.report) {
    try {
      const rep = JSON.parse(latest.report);
      failedNames = (rep.checks || []).filter((c: any) => !c.ok).map((c: any) => c.name);
      warnNames = (rep.checks || []).filter((c: any) => c.ok && c.warn).map((c: any) => c.name);
    } catch (e) {
      /* ignore */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>平台自检</CardTitle>
        <CardDescription>全链路体检：基础设施 / 网关 / 流式 / 通道 / 数据（每日 04:15 自动 + 随时手动）。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        <div className='flex items-center gap-3'>
          {latest ? (
            <Badge
              variant={latest.failed ? 'destructive' : 'default'}
              className={latest.failed ? '' : 'bg-emerald-600 text-white hover:bg-emerald-600'}
            >
              {latest.failed ? '未通过 ' + latest.passed + '/' + latest.total : '通过 ' + latest.passed + '/' + latest.total}
            </Badge>
          ) : (
            <Badge variant='outline'>暂无记录</Badge>
          )}
          <Button size='sm' variant='outline' disabled={running} onClick={runNow}>
            {running ? '自检中…' : '立即自检'}
          </Button>
          {msg ? <span className='text-muted-foreground'>{msg}</span> : null}
        </div>
        {latest ? (
          <div className='text-muted-foreground flex flex-col gap-1 border-t pt-3'>
            <span>
              {fmtTime(latest.checked_at || latest.createdAt)} · {latest.source === 'manual' ? '手动' : '定时'} · {latest.duration_ms}ms · 警告 {latest.warned || 0}
            </span>
            {failedNames.length ? <span className='text-destructive'>失败：{failedNames.join('、')}</span> : null}
            {warnNames.length ? <span>警告：{warnNames.join('、')}</span> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
