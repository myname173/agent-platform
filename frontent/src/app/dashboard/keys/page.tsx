import PageContainer from '@/components/layout/page-container';
import { KeysPanel } from '@/features/keys/components/keys-panel';

export const metadata = {
  title: 'Dashboard: API Keys'
};

export default function KeysPage() {
  return (
    <PageContainer
      pageTitle='API Keys'
      pageDescription='托管 API Key 的签发、停用与限额（网关侧即时生效）。'
    >
      <KeysPanel />
    </PageContainer>
  );
}
