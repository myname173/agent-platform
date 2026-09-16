'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface AlertItem {
  kind: string;
  message: string;
  error_rate: number | null;
  total: number | null;
  errors: number | null;
  threshold: number | null;
  delivered: string | null;
  created_at: string;
}

interface AlertsPayload {
  ok: boolean;
  delivery: { configured: boolean; format: string };
  alerts: AlertItem[];
}

const fmtTime = (iso?: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso as string;
  }
};

function DeliveryBadge({ delivered }: { delivered: string | null }) {
  if (!delivered) return <Badge variant='outline'>—</Badge>;
  if (delivered === 'ok')
    return (
      <Badge variant='default' className='bg-emerald-600 text-white hover:bg-emerald-600'>
        已触达
      </Badge>
    );
  if (delivered.startsWith('skipped')) return <Badge variant='outline'>未配置渠道</Badge>;
  return <Badge variant='destructive'>触达失败</Badge>;
}

function kindLabel(kind: string) {
  if (kind === 'error_rate') return '错误率';
  if (kind === 'embedding_quota') return '嵌入额度';
  return kind;
}

export function AlertsPanel() {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/n8n/alerts', { cache: 'no-store' });
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

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/n8n/alerts', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (body?.ok && body?.sent) setTestResult({ ok: true, text: `测试通知已发送（${body.format}）` });
      else setTestResult({ ok: false, text: body?.reason || body?.error || '发送失败' });
    } catch (e: any) {
      setTestResult({ ok: false, text: String(e?.message || e) });
    } finally {
      setTesting(false);
    }
  };

  const delivery = data?.delivery;

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>触达渠道</CardTitle>
          <CardDescription>
            {delivery
              ? delivery.configured
                ? `已配置（format: ${delivery.format}）—— 告警将推送到已配置渠道`
                : '未配置：在根 .env 设置推送渠道并执行 docker compose up -d n8n（支持 Telegram / Slack / Discord / 飞书 / 企微，见 README「推送渠道」）'
              : '加载中…'}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <div className='flex items-center gap-3'>
            {delivery ? (
              <Badge variant={delivery.configured ? 'default' : 'outline'}>{delivery.configured ? '已配置' : '未配置'}</Badge>
            ) : null}
            <Button size='sm' variant='outline' disabled={testing} onClick={sendTest}>
              {testing ? '发送中…' : '发送测试通知'}
            </Button>
          </div>
          {testResult ? (
            <p className={'text-sm ' + (testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
              {testResult.text}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>告警历史</CardTitle>
          <CardDescription>{data ? `${data.alerts.length} 条记录` : '加载中…'}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className='text-destructive text-sm'>加载失败：{loadError}</p>
          ) : !data ? (
            <div className='flex flex-col gap-2'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : data.alerts.length === 0 ? (
            <p className='text-muted-foreground text-sm'>暂无告警记录——平台安静运行中。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>消息</TableHead>
                  <TableHead>错误率</TableHead>
                  <TableHead>触达</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.alerts.map((a, i) => (
                  <TableRow key={a.created_at + ':' + i}>
                    <TableCell className='text-muted-foreground whitespace-nowrap text-xs'>{fmtTime(a.created_at)}</TableCell>
                    <TableCell>
                      <Badge variant='secondary'>{kindLabel(a.kind)}</Badge>
                    </TableCell>
                    <TableCell className='max-w-[420px] truncate text-sm' title={a.message}>
                      {a.message}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {a.error_rate === null || a.error_rate === undefined ? '—' : (a.error_rate * 100).toFixed(1) + '%'}
                    </TableCell>
                    <TableCell>
                      <DeliveryBadge delivered={a.delivered} />
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
