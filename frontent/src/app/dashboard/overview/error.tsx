'use client';

import { Button } from '@/components/ui/button';
import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function OverviewError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center'>
      <h2 className='text-lg font-semibold'>总览加载失败</h2>
      <p className='text-muted-foreground text-sm'>{error.message}</p>
      <Button onClick={() => reset()}>重试</Button>
    </div>
  );
}
