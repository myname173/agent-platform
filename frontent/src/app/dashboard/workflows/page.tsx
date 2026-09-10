import PageContainer from '@/components/layout/page-container';
import OperationsDashboard from '@/features/workflows/components/operations-dashboard';

export const metadata = {
  title: 'Dashboard: Workflows'
};

export default function WorkflowsPage() {
  return (
    <PageContainer
      pageTitle="Workflows"
      pageDescription="Chat Gateway 运行态势与执行明细。"
    >
      <OperationsDashboard />
    </PageContainer>
  );
}
