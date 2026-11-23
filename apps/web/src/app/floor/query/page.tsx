import type { Metadata } from 'next';
import { ScreenGuard } from '@/components/ScreenGuard';
import { t } from '@/i18n';
import { QueryScreen } from './QueryScreen';

export const metadata: Metadata = { title: t('floor.screens.query') };

export default function Page() {
  return (
    <ScreenGuard screen="floor.query">
      <QueryScreen />
    </ScreenGuard>
  );
}
