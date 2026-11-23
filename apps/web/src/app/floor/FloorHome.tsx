'use client';

import Link from 'next/link';
import { floorScreensFor } from '@dayson/domain';
import { Icon } from '@/components/icons';
import { t } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import { DEV_NO_AUTH } from '@/lib/env';
import { useOutbox } from '@/lib/floor/outbox/react';

/** Home tiles for the nine screens of spec 5.1, filtered by role. */
export function FloorHome() {
  const { status, profile, role, signOut, refresh } = useProfile();
  const { queued } = useOutbox();
  const screens = floorScreensFor(role);

  if (status === 'loading') {
    return (
      <p role="status" className="p-4 text-lg text-muted">
        {t('app.loading')}
      </p>
    );
  }

  const problem =
    status === 'inactive'
      ? t('auth.inactive')
      : status === 'missing' || status === 'signed_out'
        ? t('auth.noProfile')
        : status === 'error'
          ? t('auth.profileError')
          : screens.length === 0
            ? t('auth.noAccessTitle')
            : null;

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="px-1">
        <p className="text-xl font-extrabold leading-tight">{t('floor.greeting', { name: profile?.full_name || '—' })}</p>
        <p className="text-sm font-medium text-muted">
          {role ? t(`roles.${role}`) : ''}
          {DEV_NO_AUTH ? ` · ${t('auth.devMode')}` : ''}
        </p>
      </div>

      {problem ? (
        <div role="alert" className="rounded-xl border-2 border-brand bg-brand-soft p-4 text-lg font-bold text-brand-dark">
          {problem}
          {status === 'error' ? (
            <button type="button" onClick={refresh} className="mt-3 block min-h-14 w-full rounded-xl bg-ink text-lg font-bold text-paper">
              {t('app.retry')}
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-2.5">
          {screens.map((screen) => (
            <li key={screen}>
              <Link
                href={`/floor/${screen}`}
                data-testid={`tile-${screen}`}
                className={`flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border-2 p-1 text-center active:scale-[0.97] ${
                  screen === 'tasks' ? 'border-brand bg-brand text-paper' : 'border-ink bg-paper text-ink'
                }`}
              >
                <Icon name={screen} size={40} strokeWidth={2.2} />
                <span className="text-[15px] font-extrabold leading-tight">{t(`floor.screens.${screen}`)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-2">
        {queued > 0 ? <p className="mb-2 text-center text-sm font-semibold text-brand-dark">{t('auth.signOutBlocked', { count: queued })}</p> : null}
        <button
          type="button"
          onClick={() => void signOut()}
          // Queued commands replay under this user's session; do not lose them.
          disabled={queued > 0}
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-line-strong bg-paper text-lg font-bold text-ink disabled:opacity-40"
        >
          <Icon name="signOut" />
          {t('auth.signOut')}
        </button>
      </div>
    </div>
  );
}
