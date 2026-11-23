import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { PickScreen } from './PickScreen';

export const metadata: Metadata = { title: t('floor.screens.pick') };

export default function Page() {
  return (
    <FloorPage screen="floor.pick">
      <PickScreen />
    </FloorPage>
  );
}
