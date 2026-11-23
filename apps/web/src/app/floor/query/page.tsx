import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { QueryScreen } from './QueryScreen';

export const metadata: Metadata = { title: t('floor.screens.query') };

export default function Page() {
  return (
    <FloorPage screen="floor.query">
      <QueryScreen />
    </FloorPage>
  );
}
