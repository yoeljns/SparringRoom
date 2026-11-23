import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { PutawayScreen } from './PutawayScreen';

export const metadata: Metadata = { title: t('floor.screens.putaway') };

export default function Page() {
  return (
    <FloorPage screen="floor.putaway">
      <PutawayScreen />
    </FloorPage>
  );
}
