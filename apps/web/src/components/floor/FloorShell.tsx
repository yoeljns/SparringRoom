'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { FLOOR_SCREENS, type FloorScreen } from '@dayson/domain';
import { t, type MessageKey } from '@/i18n';
import { unlockAudio } from '@/lib/floor/feedback';
import { useOutbox } from '@/lib/floor/outbox/react';
import { BrandMark } from '../Brand';
import { Icon, type IconName } from '../icons';
import { OutboxBadge } from './OutboxBadge';

function titleFor(pathname: string): string {
  const segment = pathname.split('/')[2];
  if (!segment) return t('app.floorName');
  if (segment === 'outbox') return t('outbox.title');
  if ((FLOOR_SCREENS as readonly string[]).includes(segment)) return t(`floor.screens.${segment as FloorScreen}`);
  return t('app.floorName');
}

const BOTTOM_NAV: { href: string; label: MessageKey; icon: IconName }[] = [
  { href: '/floor', label: 'floor.home', icon: 'home' },
  { href: '/floor/tasks', label: 'floor.screens.tasks', icon: 'tasks' },
  { href: '/floor/query', label: 'floor.screens.query', icon: 'query' },
  { href: '/floor/outbox', label: 'outbox.badge', icon: 'outbox' },
];

/** Full-screen handheld layout: black header with the queue counter, content, bottom navigation. */
export function FloorShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/floor';
  const isHome = pathname === '/floor';
  const { online } = useOutbox();

  // Audio may only start after a user gesture; unlock it on the first touch.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  return (
    <div className="floor-root flex h-dvh flex-col bg-surface text-ink">
      <header className="flex h-16 shrink-0 items-center gap-2 bg-ink px-2 text-paper">
        {isHome ? (
          <span className="flex h-12 w-12 items-center justify-center">
            <BrandMark size={40} />
          </span>
        ) : (
          <Link
            href="/floor"
            aria-label={t('app.back')}
            className="flex h-12 w-12 items-center justify-center rounded-lg active:bg-ink-2"
          >
            <Icon name="chevronLeft" size={30} />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-extrabold leading-tight">{titleFor(pathname)}</h1>
          <p
            data-testid="connection"
            className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${online ? 'text-paper/70' : 'text-paper'}`}
          >
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-ok' : 'bg-brand'}`} />
            {online ? t('floor.online') : t('floor.offline')}
          </p>
        </div>
        <OutboxBadge />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">{children}</main>

      <nav aria-label={t('office.menu')} className="grid h-[4.5rem] shrink-0 grid-cols-4 border-t-2 border-line bg-paper">
        {BOTTOM_NAV.map((item) => {
          const active = item.href === '/floor' ? isHome : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 border-t-4 text-xs font-bold ${
                active ? 'border-brand text-ink' : 'border-transparent text-muted'
              }`}
            >
              <Icon name={item.icon} size={26} />
              {t(item.label)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
