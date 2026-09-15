import PageContainer from '@/components/layout/page-container';
import { AlertsPanel } from '@/features/alerts/components/alerts-panel';

export const metadata = {
  title: 'Dashboard: Alerts'
};

export default function AlertsPage() {
  return (
    <PageContainer pageTitle='Alerts' pageDescription='告警历史与触达渠道（错误率 / 嵌入额度）。'>
      <AlertsPanel />
    </PageContainer>
  );
}
