import type { Metadata } from 'next';
import { ApprovalsScreen } from '@/components/office/screens/ApprovalsScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.approvals') };

export default function Page() {
  return (
    <Section screen="approvals">
      <ApprovalsScreen />
    </Section>
  );
}
