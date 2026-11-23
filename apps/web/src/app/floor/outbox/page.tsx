import type { Metadata } from 'next';
import { t } from '@/i18n';
import { OutboxScreen } from './OutboxScreen';

export const metadata: Metadata = { title: t('outbox.title') };

export default function Page() {
  return <OutboxScreen />;
}
