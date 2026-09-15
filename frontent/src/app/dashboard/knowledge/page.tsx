import PageContainer from '@/components/layout/page-container';
import { KnowledgePanel } from '@/features/knowledge/components/knowledge-panel';

export const metadata = {
  title: 'Dashboard: Knowledge'
};

export default function KnowledgePage() {
  return (
    <PageContainer
      pageTitle='Knowledge'
      pageDescription='私域知识库：文档摄取、状态与嵌入额度。'
    >
      <KnowledgePanel />
    </PageContainer>
  );
}
