import type { Metadata } from 'next';
import { ScreenGuard } from '@/components/ScreenGuard';
import { t } from '@/i18n';
import { TransferTrial } from './TransferTrial';

export const metadata: Metadata = { title: t('floor.screens.transfer') };

export default function Page() {
  return (
    <ScreenGuard screen="floor.transfer">
      <TransferTrial />
    </ScreenGuard>
  );
}
