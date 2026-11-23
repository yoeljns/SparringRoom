import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { CountScreen } from './CountScreen';

export const metadata: Metadata = { title: t('floor.screens.count') };

export default function Page() {
  return (
    <FloorPage screen="floor.count">
      <CountScreen />
    </FloorPage>
  );
}
