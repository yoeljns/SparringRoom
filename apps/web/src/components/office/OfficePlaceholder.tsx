import type { OfficeScreen } from '@dayson/domain';
import { t } from '@/i18n';
import { Icon } from '../icons';
import { ScreenGuard } from '../ScreenGuard';

/** Placeholder for a back-office section whose data wiring comes in the next pass. */
export function OfficePlaceholder({ screen }: { screen: OfficeScreen }) {
  return (
    <ScreenGuard screen={`office.${screen}`}>
      <section className="max-w-3xl rounded-lg border border-line bg-paper p-8">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-ink text-paper">
            <Icon name={screen} />
          </span>
          <div>
            <h2 className="text-lg font-bold">{t(`office.nav.${screen}`)}</h2>
            <p className="mt-1 text-ink-soft">{t(`office.desc.${screen}`)}</p>
          </div>
        </div>
        <div className="mt-6 rounded-md border border-dashed border-line-strong bg-surface p-5">
          <p className="font-semibold">{t('app.comingSoon')}</p>
          <p className="mt-1 text-sm text-muted">{t('app.comingSoonDetail')}</p>
        </div>
      </section>
    </ScreenGuard>
  );
}
