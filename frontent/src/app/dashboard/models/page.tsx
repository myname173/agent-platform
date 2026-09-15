import PageContainer from '@/components/layout/page-container';
import { ModelsPanel } from '@/features/models/components/models-panel';

export const metadata = {
  title: 'Dashboard: Models'
};

export default function ModelsPage() {
  return (
    <PageContainer
      pageTitle='Models'
      pageDescription='模型别名、计价与使用情况（实时读取网关配置）。'
    >
      <ModelsPanel />
    </PageContainer>
  );
}
