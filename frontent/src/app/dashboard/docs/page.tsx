import PageContainer from '@/components/layout/page-container';
import { DocsPanel } from '@/features/docs/components/docs-panel';

export const metadata = {
  title: 'Dashboard: Docs'
};

export default function DocsPage() {
  return (
    <PageContainer
      pageTitle='Docs'
      pageDescription='文档工厂：会议纪要 / 周报 / 晨报 → 可打印、可发人的成品文档。'
    >
      <DocsPanel />
    </PageContainer>
  );
}
