import type { Metadata } from 'next';
import { OrdersScreen } from '@/components/office/screens/OrdersScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.orders') };

export default function Page() {
  return (
    <Section screen="orders">
      <OrdersScreen />
    </Section>
  );
}
