import type { Metadata } from 'next';
import { CampaignsScreen } from '@/components/office/screens/CampaignsScreen';
import { Section } from '@/components/office/ui';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('office.nav.campaigns') };

export default function Page() {
  return (
    <Section screen="campaigns">
      <CampaignsScreen />
    </Section>
  );
}
