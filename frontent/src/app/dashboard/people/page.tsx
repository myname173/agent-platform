import PageContainer from '@/components/layout/page-container';
import { PeoplePanel } from '@/features/people/components/people-panel';

export const metadata = {
  title: 'Dashboard: People'
};

export default function PeoplePage() {
  return (
    <PageContainer
      pageTitle='People'
      pageDescription='人员目录：待办、提醒与周报的归属对象（机主手动录入，无自助注册）。'
    >
      <PeoplePanel />
    </PageContainer>
  );
}
