import type { Metadata } from 'next';
import { AuditScreen } from '@/components/office/screens/AuditScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.audit') };

export default function Page() {
  return (
    <Section screen="audit">
      <AuditScreen />
    </Section>
  );
}
