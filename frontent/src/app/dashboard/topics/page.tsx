import { TopicsPanel } from '@/features/topics/components/topics-panel';

export default function TopicsPage() {
  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div>
        <h1 className='text-xl font-semibold tracking-tight'>动态监控</h1>
        <p className='text-muted-foreground text-sm'>
          跟踪外部信号：加关键词 → 每天 21:00 自动检索 → 值得关注的推送到 Telegram。
        </p>
      </div>
      <TopicsPanel />
    </div>
  );
}
