import type { Metadata } from 'next';
import { FloorPage } from '@/components/floor/ui';
import { t } from '@/i18n';
import { TasksScreen } from './TasksScreen';

export const metadata: Metadata = { title: t('floor.screens.tasks') };

export default function Page() {
  return (
    <FloorPage screen="floor.tasks">
      <TasksScreen />
    </FloorPage>
  );
}
