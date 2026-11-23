import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Loading } from '@/components/floor/ui';
import { t } from '@/i18n';
import { DealerScreen } from './DealerScreen';

export const metadata: Metadata = { title: t('floor.dealer.title') };

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <DealerScreen />
    </Suspense>
  );
}
