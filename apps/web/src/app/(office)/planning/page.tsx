import type { Metadata } from 'next';
import { PlanningScreen } from '@/components/office/screens/PlanningScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.planning') };

export default function Page() {
  return (
    <Section screen="planning">
      <PlanningScreen />
    </Section>
  );
}
