'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface PlatformSettings {
  ok: boolean;
  alerts: {
    window_min: number;
    rate_threshold: number;
    min_total: number;
    cooldown_min: number;
    webhook_configured: boolean;
    webhook_format: string;
  };
  embedding: { quota_tokens: number };
  retention: { messages_days: number; executions_days: number };
  note: string;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='flex items-center justify-between border-b py-2 text-sm last:border-b-0'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium tabular-nums'>{value}</span>
    </div>
  );
}

export function SettingsPanel() {
  const [data, setData] = useState<PlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/n8n/settings', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((e) => {
        if (alive) setError(String((e && e.message) || e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>设置加载失败</CardTitle>
          <CardDescription>请检查 n8n Platform Admin API（/admin/settings）。</CardDescription>
        </CardHeader>
        <CardContent className='text-muted-foreground text-sm'>{error}</CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className='h-4 w-28' />
              <Skeleton className='h-20 w-full' />
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  const a = data.alerts;

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>告警配置</CardTitle>
            <CardDescription>Chat Alerts 巡检参数（来自 n8n 环境变量）。</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col'>
            <Row label='检查窗口' value={a.window_min + ' 分钟'} />
            <Row label='错误率阈值' value={(a.rate_threshold * 100).toFixed(0) + '%'} />
            <Row label='最小样本数' value={String(a.min_total)} />
            <Row label='冷却时间' value={a.cooldown_min + ' 分钟'} />
            <Row
              label='触达渠道'
              value={
                a.webhook_configured ? (
                  <Badge variant='default'>已配置（{a.webhook_format}）</Badge>
                ) : (
                  <Badge variant='outline'>未配置</Badge>
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>知识库与保留策略</CardTitle>
            <CardDescription>嵌入额度与数据生命周期。</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col'>
            <Row label='嵌入额度' value={Number(data.embedding.quota_tokens).toLocaleString('en-US') + ' tokens'} />
            <Row label='消息保留' value={data.retention.messages_days + ' 天'} />
            <Row label='执行记录保留' value={data.retention.executions_days + ' 天'} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>如何修改</CardTitle>
          <CardDescription>
            以上参数与告警渠道均来自根目录 <code className='font-mono text-xs'>.env</code>。修改步骤：
            编辑 .env → 执行 <code className='font-mono text-xs'>docker compose up -d n8n</code>（重启生效）。
            密钥的限流与预算请在「Keys」页调整（立即生效，无需重启）。
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
