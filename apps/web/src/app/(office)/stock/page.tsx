import type { Metadata } from 'next';
import { StockScreen } from '@/components/office/screens/StockScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.stock') };

export default function Page() {
  return (
    <Section screen="stock">
      <StockScreen />
    </Section>
  );
}
