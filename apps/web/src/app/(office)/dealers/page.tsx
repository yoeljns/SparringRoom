import type { Metadata } from 'next';
import { DealersScreen } from '@/components/office/screens/DealersScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.dealers') };

export default function Page() {
  return (
    <Section screen="dealers">
      <DealersScreen />
    </Section>
  );
}
