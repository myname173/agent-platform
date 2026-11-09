import PageContainer from '@/components/layout/page-container';
import { ProjectsPanel } from '@/features/projects/components/projects-panel';

export const metadata = {
  title: 'Dashboard: Projects'
};

export default function ProjectsPage() {
  return (
    <PageContainer
      pageTitle='Projects'
      pageDescription='项目登记表：待办、文档与对外验收报告的归属对象（slug 建后不可改，停用请归档）。'
    >
      <ProjectsPanel />
    </PageContainer>
  );
}
