import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { LoadScreen } from './LoadScreen';

export const metadata: Metadata = { title: t('floor.screens.load') };

export default function Page() {
  return (
    <FloorPage screen="floor.load">
      <LoadScreen />
    </FloorPage>
  );
}
