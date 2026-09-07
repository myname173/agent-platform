import PageContainer from '@/components/layout/page-container';
import WorkflowDashboard from '@/features/workflows/components/workflow-dashboard';

export const metadata = {
  title: 'Dashboard: Workflows'
};

export default function WorkflowsPage() {
  return (
    <PageContainer
      pageTitle="Workflows"
      pageDescription="Manage and monitor your n8n workflows."
    >
      <WorkflowDashboard />
    </PageContainer>
  );
}
