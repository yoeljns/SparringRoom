import type { Metadata } from 'next';
import { AlertsScreen } from '@/components/office/screens/AlertsScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.alerts') };

export default function Page() {
  return (
    <Section screen="alerts">
      <AlertsScreen />
    </Section>
  );
}
