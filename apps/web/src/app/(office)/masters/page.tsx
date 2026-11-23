import type { Metadata } from 'next';
import { MastersScreen } from '@/components/office/screens/MastersScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.masters') };

export default function Page() {
  return (
    <Section screen="masters">
      <MastersScreen />
    </Section>
  );
}
