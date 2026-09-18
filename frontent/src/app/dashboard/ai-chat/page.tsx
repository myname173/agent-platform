import PageContainer from '@/components/layout/page-container';
import { AgentPlayground } from '@/features/ai-chat/components/agent-playground';

export const metadata = {
  title: 'Dashboard: Agent Playground'
};

export default function Page() {
  return (
    <PageContainer>
      <AgentPlayground />
    </PageContainer>
  );
}
