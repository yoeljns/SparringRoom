'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { useOutbox } from '@/lib/floor/outbox/react';
import { Icon } from '../icons';

/**
 * Wrap a task-completion step (truck close, count submit, receipt finish).
 * The children appear only when every queued command has reached the server
 * (spec section 2, "Offline"). Rejected commands must be looked at first too,
 * because the task may depend on them.
 */
export function BlockUntilDrained({ children, blockOnRejected = true }: { children: ReactNode; blockOnRejected?: boolean }) {
  const { ready, queued, rejected, online, draining, lastError, drain } = useOutbox();

  if (!ready) {
    return (
      <p role="status" className="p-4 text-lg text-muted">
        {t('app.loading')}
      </p>
    );
  }

  if (queued > 0) {
    return (
      <div role="alert" data-testid="blocked-queued" className="rounded-xl border-2 border-ink bg-paper p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper">
            <Icon name={online ? 'outbox' : 'wifiOff'} size={26} />
          </span>
          <h2 className="text-xl font-extrabold leading-tight">{t('outbox.blockedTitle')}</h2>
        </div>
        <p className="mt-3 text-lg text-ink-soft">{t('outbox.blockedBody', { count: queued })}</p>
        <p className="mt-1 text-base font-semibold text-ink">
          {!online ? t('outbox.waitingNetwork') : draining ? t('outbox.sending') : (lastError ?? '')}
        </p>
        <button
          type="button"
          onClick={() => void drain()}
          disabled={!online || draining}
          className="mt-4 min-h-14 w-full rounded-xl bg-ink px-4 text-lg font-bold text-paper disabled:opacity-50"
        >
          {t('outbox.sendNow')}
        </button>
      </div>
    );
  }

  if (blockOnRejected && rejected > 0) {
    return (
      <div role="alert" data-testid="blocked-rejected" className="rounded-xl border-2 border-brand bg-brand-soft p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-paper">
            <Icon name="alert" size={26} />
          </span>
          <h2 className="text-xl font-extrabold leading-tight">{t('outbox.blockedRejectedTitle')}</h2>
        </div>
        <p className="mt-3 text-lg text-ink-soft">{t('outbox.blockedRejectedBody', { count: rejected })}</p>
        <Link
          href="/floor/outbox"
          className="mt-4 flex min-h-14 w-full items-center justify-center rounded-xl bg-brand px-4 text-lg font-bold text-paper"
        >
          {t('outbox.review')}
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
