import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { TransferScreen } from './TransferScreen';

export const metadata: Metadata = { title: t('floor.screens.transfer') };

export default function Page() {
  return (
    <FloorPage screen="floor.transfer">
      <TransferScreen />
    </FloorPage>
  );
}
