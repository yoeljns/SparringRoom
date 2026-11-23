import type { Metadata } from 'next';
import { SupplyScreen } from '@/components/office/screens/SupplyScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.supply') };

export default function Page() {
  return (
    <Section screen="supply">
      <SupplyScreen />
    </Section>
  );
}
