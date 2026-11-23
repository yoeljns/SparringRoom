import type { FloorScreen } from '@dayson/domain';
import { t } from '@/i18n';
import { Icon } from '../icons';
import { ScreenGuard } from '../ScreenGuard';

/** Placeholder for a floor screen whose data wiring comes in the next pass. */
export function FloorPlaceholder({ screen }: { screen: FloorScreen }) {
  return (
    <ScreenGuard screen={`floor.${screen}`}>
      <div className="rounded-xl border-2 border-dashed border-line-strong bg-paper p-5 text-center">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-ink text-paper">
          <Icon name={screen} size={34} />
        </span>
        <h2 className="mt-3 text-2xl font-extrabold">{t(`floor.screens.${screen}`)}</h2>
        <p className="mt-1 text-lg text-ink-soft">{t(`floor.desc.${screen}`)}</p>
        <p className="mt-4 text-base font-semibold text-muted">{t('app.comingSoon')}</p>
      </div>
    </ScreenGuard>
  );
}
