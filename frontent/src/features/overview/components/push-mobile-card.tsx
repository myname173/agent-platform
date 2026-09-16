'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface DeliveryInfo {
  configured: boolean;
  format: string;
}

const LAN_HOST = '192.168.1.114';

export function PushMobileCard() {
  const [delivery, setDelivery] = useState<DeliveryInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/n8n/alerts', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setDelivery(j?.delivery ?? null))
      .catch(() => {});
  }, []);

  const sendTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch('/api/n8n/alerts', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (body?.ok && body?.sent) setResult({ ok: true, text: '测试推送已发送（' + body.format + '）' });
      else setResult({ ok: false, text: body?.reason || body?.error || '发送失败' });
    } catch (e: any) {
      setResult({ ok: false, text: String(e?.message || e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>推送与移动</CardTitle>
        <CardDescription>手机接收推送（Telegram / 飞书 / 企微）与局域网访问。</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3 text-sm'>
        <div className='flex items-center gap-3'>
          {delivery ? (
            <Badge variant={delivery.configured ? 'default' : 'outline'}>
              {delivery.configured ? '已配置 · ' + delivery.format : '未配置'}
            </Badge>
          ) : null}
          <Button size='sm' variant='outline' disabled={testing} onClick={sendTest}>
            {testing ? '发送中…' : '发送测试推送'}
          </Button>
          {result ? (
            <span className={result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>{result.text}</span>
          ) : null}
        </div>
        <div className='flex flex-col gap-1 border-t pt-3'>
          <span className='font-medium'>手机访问（同一 Wi-Fi）</span>
          <span className='text-muted-foreground'>
            对话：
            <a className='underline' href={'http://' + LAN_HOST + ':3210'} target='_blank' rel='noreferrer'>
              http://{LAN_HOST}:3210
            </a>
            &nbsp;·&nbsp;控制台：
            <a className='underline' href={'http://' + LAN_HOST + ':3000'} target='_blank' rel='noreferrer'>
              http://{LAN_HOST}:3000
            </a>
          </span>
          <span className='text-muted-foreground'>提示：浏览器菜单可「添加到主屏幕」；打不开时检查防火墙规则（README「手机访问」）。</span>
        </div>
      </CardContent>
    </Card>
  );
}
