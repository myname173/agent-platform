import PageContainer from '@/components/layout/page-container';
import { BriefsPanel } from '@/features/briefs/components/briefs-panel';

export const metadata = {
  title: 'Dashboard: Briefs'
};

export default function BriefsPage() {
  return (
    <PageContainer pageTitle='Briefs' pageDescription='每日晨报：定时汇总检索结果与平台状态（支持手动生成）。'>
      <BriefsPanel />
    </PageContainer>
  );
}
