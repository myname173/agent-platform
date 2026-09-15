import PageContainer from '@/components/layout/page-container';
import { PlatformOverview } from '@/features/overview/components/platform-overview';

export const metadata = {
  title: 'Dashboard: Platform Overview'
};

export default function OverviewPage() {
  return (
    <PageContainer
      pageTitle='Platform Overview'
      pageDescription='平台运行总览：对话、告警、知识库与嵌入额度。'
    >
      <PlatformOverview />
    </PageContainer>
  );
}
