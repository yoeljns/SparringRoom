import type { Metadata } from 'next';
import { DashboardScreen } from '@/components/office/screens/DashboardScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.dashboard') };

export default function Page() {
  return (
    <Section screen="dashboard">
      <DashboardScreen />
    </Section>
  );
}
