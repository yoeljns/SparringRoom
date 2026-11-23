import type { Metadata } from 'next';
import { FloorPlaceholder } from '@/components/floor/FloorPlaceholder';
import { t } from '@/i18n';

export const metadata: Metadata = { title: t('floor.screens.load') };

export default function Page() {
  return <FloorPlaceholder screen="load" />;
}
