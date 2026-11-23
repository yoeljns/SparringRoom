import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { ReceiveScreen } from './ReceiveScreen';

export const metadata: Metadata = { title: t('floor.screens.receive') };

export default function Page() {
  return (
    <FloorPage screen="floor.receive">
      <ReceiveScreen />
    </FloorPage>
  );
}
