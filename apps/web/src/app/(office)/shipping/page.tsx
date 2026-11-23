import type { Metadata } from 'next';
import { ShippingScreen } from '@/components/office/screens/ShippingScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.shipping') };

export default function Page() {
  return (
    <Section screen="shipping">
      <ShippingScreen />
    </Section>
  );
}
