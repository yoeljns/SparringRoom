'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { OFFICE_SCREENS, floorScreensFor, officeScreensFor, type OfficeScreen } from '@dayson/domain';
import { t } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import { DEV_NO_AUTH } from '@/lib/env';
import { Brand } from '../Brand';
import { Icon } from '../icons';

function currentScreen(pathname: string): OfficeScreen | null {
  const segment = pathname.split('/')[1];
  return (OFFICE_SCREENS as readonly string[]).includes(segment) ? (segment as OfficeScreen) : null;
}

/** Back-office layout: black sidebar with role-aware navigation, white content area. */
export function OfficeShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const { profile, role, status, signOut } = useProfile();
  const [open, setOpen] = useState(false);
  const screens = officeScreensFor(role);
  const active = currentScreen(pathname);
  const hasFloor = floorScreensFor(role).length > 0;

  const nav = (
    <nav aria-label={t('office.menu')} className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-4">
      {status === 'loading' ? <p className="px-3 text-sm text-paper/60">{t('app.loading')}</p> : null}
      {screens.map((screen) => {
        const isActive = screen === active;
        return (
          <Link
            key={screen}
            href={`/${screen}`}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => setOpen(false)}
            className={`flex min-h-11 items-center gap-3 rounded-md border-l-4 px-3 text-[15px] font-medium transition-colors ${
              isActive ? 'border-brand bg-ink-2 text-paper' : 'border-transparent text-paper/75 hover:bg-ink-2 hover:text-paper'
            }`}
          >
            <Icon name={screen} size={20} />
            {t(`office.nav.${screen}`)}
          </Link>
        );
      })}
      {hasFloor ? (
        <Link
          href="/floor"
          className="mt-4 flex min-h-11 items-center gap-3 rounded-md border border-ink-soft px-3 text-[15px] font-medium text-paper/85 hover:bg-ink-2 hover:text-paper"
        >
          <Icon name="barcode" size={20} />
          {t('office.openFloor')}
        </Link>
      ) : null}
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-surface">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-ink text-paper transition-transform md:sticky md:top-0 md:h-dvh md:shrink-0 md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-ink-2 px-5">
          <Brand label="Dayson" size={32} />
        </div>
        {nav}
        <div className="shrink-0 border-t border-ink-2 p-4">
          <p className="truncate text-sm font-semibold">{profile?.full_name || '—'}</p>
          <p className="truncate text-xs text-paper/60">{role ? t(`roles.${role}`) : ''}</p>
          {DEV_NO_AUTH ? <p className="mt-1 text-xs font-semibold text-brand">{t('auth.devMode')}</p> : null}
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-ink-soft text-sm font-semibold text-paper hover:bg-ink-2"
          >
            <Icon name="signOut" size={18} />
            {t('auth.signOut')}
          </button>
        </div>
      </aside>
      {open ? (
        <button
          type="button"
          aria-label={t('app.close')}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-ink/50 md:hidden"
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-paper px-4 md:px-8">
          <button
            type="button"
            aria-label={t('office.menu')}
            onClick={() => setOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-line md:hidden"
          >
            <Icon name="menu" />
          </button>
          <h1 className="text-xl font-bold tracking-tight">{active ? t(`office.nav.${active}`) : t('app.name')}</h1>
        </header>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
