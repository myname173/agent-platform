'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface ModelEntry {
  alias: string;
  upstream: string;
  tools: boolean;
  pricing: { input: number; cache_hit: number; output: number } | null;
  calls_30d: number;
  cost_30d: number;
  is_default: boolean;
}

interface ModelsPayload {
  ok: boolean;
  default_model: string | null;
  models: ModelEntry[];
  note: string;
}

const fmtUsd = (v: number, d = 4) => '$' + Number(v || 0).toFixed(d);
const perM = (v: number) => '$' + Number(v).toFixed(v >= 1 ? 2 : 4);

export function ModelsPanel() {
  const [data, setData] = useState<ModelsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/n8n/models', { cache: 'no-store' })
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
          <CardTitle>模型列表加载失败</CardTitle>
          <CardDescription>请检查 n8n Platform Admin API（/admin/models）。</CardDescription>
        </CardHeader>
        <CardContent className='text-muted-foreground text-sm'>{error}</CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div className='flex flex-col gap-2'>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className='h-10 w-full' />
        ))}
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle>模型路由总览</CardTitle>
          <CardDescription>
            别名与计价从 Chat Gateway 工作流实时读取；用量统计为最近 30 天（基于 1000 条近期执行记录）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>别名</TableHead>
                <TableHead>上游模型</TableHead>
                <TableHead>工具</TableHead>
                <TableHead>计价 / 1M tokens（入 / 缓存 / 出）</TableHead>
                <TableHead>近 30 天调用</TableHead>
                <TableHead>近 30 天成本</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((m) => (
                <TableRow key={m.alias}>
                  <TableCell className='font-mono text-sm'>
                    {m.alias}
                    {m.is_default ? (
                      <Badge variant='secondary' className='ml-2'>
                        默认
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>{m.upstream}</TableCell>
                  <TableCell>{m.tools ? <Badge>开</Badge> : <Badge variant='outline'>关</Badge>}</TableCell>
                  <TableCell className='tabular-nums'>
                    {m.pricing ? (
                      <span>
                        {perM(m.pricing.input)} / {perM(m.pricing.cache_hit)} / {perM(m.pricing.output)}
                      </span>
                    ) : (
                      <span className='text-muted-foreground'>—</span>
                    )}
                  </TableCell>
                  <TableCell className='tabular-nums'>{m.calls_30d}</TableCell>
                  <TableCell className='tabular-nums'>{fmtUsd(m.cost_30d)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>如何调整</CardTitle>
          <CardDescription>
            别名、上游与计价定义在 <span className='font-mono text-xs'>Chat Gateway</span> 工作流（Parse &amp; Validate / Prep Success Log 节点）；
            LobeChat 侧模型列表由 <span className='font-mono text-xs'>docker-compose.yml</span> 的模型变量控制。新增或调价请直接告诉我（改完自动出现在本页）。
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
