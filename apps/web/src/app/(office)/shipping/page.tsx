import type { Metadata } from 'next';
import { OfficePlaceholder } from '@/components/office/OfficePlaceholder';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.shipping') };

export default function Page() {
  return <OfficePlaceholder screen="shipping" />;
}
