'use client';

import Link from 'next/link';
import { t } from '@/i18n';
import { useOutbox } from '@/lib/floor/outbox/react';
import { Icon } from '../icons';

/** Queued-command counter in the floor header; turns red when the server rejected something. */
export function OutboxBadge() {
  const { queued, rejected, online, draining } = useOutbox();
  const hasRejected = rejected > 0;
  const tone = hasRejected
    ? 'bg-brand text-paper border-brand'
    : queued > 0
      ? 'bg-paper text-ink border-paper'
      : 'bg-transparent text-paper border-ink-soft';
  return (
    <Link
      href="/floor/outbox"
      data-testid="outbox-badge"
      aria-label={`${t('outbox.title')}: ${t('outbox.queued')} ${queued}, ${t('outbox.rejected')} ${rejected}`}
      className={`flex h-12 min-w-20 items-center justify-center gap-2 rounded-lg border-2 px-3 font-bold ${tone}`}
    >
      <Icon name={online ? 'outbox' : 'wifiOff'} size={22} className={draining ? 'animate-pulse' : ''} />
      <span className="text-xl tabular-nums leading-none" data-testid="outbox-count">
        {queued}
      </span>
      {hasRejected ? (
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-paper px-1 text-sm text-brand">!{rejected}</span>
      ) : null}
    </Link>
  );
}
