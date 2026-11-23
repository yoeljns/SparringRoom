import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { QcScreen } from './QcScreen';

export const metadata: Metadata = { title: t('floor.screens.qc') };

export default function Page() {
  return (
    <FloorPage screen="floor.qc">
      <QcScreen />
    </FloorPage>
  );
}
