import PageContainer from '@/components/layout/page-container';
import { SettingsPanel } from '@/features/settings/components/settings-panel';

export const metadata = {
  title: 'Dashboard: Settings'
};

export default function SettingsPage() {
  return (
    <PageContainer
      pageTitle='Settings'
      pageDescription='平台运行参数总览（告警 / 额度 / 保留策略）。'
    >
      <SettingsPanel />
    </PageContainer>
  );
}
