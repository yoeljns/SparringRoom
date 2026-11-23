import type { Metadata } from 'next';
import { ReconciliationScreen } from '@/components/office/screens/ReconciliationScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.reconciliation') };

export default function Page() {
  return (
    <Section screen="reconciliation">
      <ReconciliationScreen />
    </Section>
  );
}
