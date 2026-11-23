'use client';

import { useEffect, useState } from 'react';
import { formatTime, t, tDynamic } from '@/i18n';
import { useOutbox } from '@/lib/floor/outbox/react';
import type { OutboxCommand, RejectedCommand } from '@/lib/floor/outbox/types';

/** Queue and rejected list. Rejected commands are shown to the operator, never retried. */
export function OutboxScreen() {
  const { queued, rejected, online, draining, lastError, nextRetryAt, drain, listQueued, listRejected, acknowledgeRejected } = useOutbox();
  const [queue, setQueue] = useState<OutboxCommand[]>([]);
  const [refused, setRefused] = useState<RejectedCommand[]>([]);

  // Reload the lists whenever the counters change.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([listQueued(), listRejected()]).then(([q, r]) => {
      if (cancelled) return;
      setQueue(q);
      setRefused(r);
    });
    return () => {
      cancelled = true;
    };
  }, [listQueued, listRejected, queued, rejected, draining]);

  const status = !online ? t('outbox.waitingNetwork') : draining ? t('outbox.sending') : nextRetryAt ? `${t('outbox.retryAt')}: ${formatTime(nextRetryAt)}` : '';

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border-2 border-ink bg-paper p-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-extrabold">
            {t('outbox.queued')} <span className="tabular-nums">({queued})</span>
          </h2>
          <button
            type="button"
            onClick={() => void drain()}
            disabled={!online || draining || queued === 0}
            className="min-h-12 rounded-lg bg-ink px-4 text-base font-bold text-paper disabled:opacity-40"
          >
            {t('outbox.sendNow')}
          </button>
        </div>
        {status ? <p className="mt-1 text-base font-semibold text-ink-soft">{status}</p> : null}
        {lastError && queued > 0 ? <p className="mt-1 break-words text-sm text-brand-dark">{lastError}</p> : null}
        {queue.length === 0 ? (
          <p className="mt-3 text-lg text-muted">{t('outbox.empty')}</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {queue.map((c) => (
              <li key={c.client_uuid} className="rounded-lg bg-surface px-3 py-2">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-base font-bold">{c.rpc}</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">{formatTime(c.event_at)}</span>
                </p>
                {c.attempts > 0 ? <p className="text-sm text-ink-soft">{t('outbox.attempts', { count: c.attempts })}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={`rounded-xl border-2 p-3 ${refused.some((r) => !r.acknowledged_at) ? 'border-brand bg-brand-soft' : 'border-line bg-paper'}`}>
        <h2 className="text-xl font-extrabold">
          {t('outbox.rejected')} <span className="tabular-nums">({rejected})</span>
        </h2>
        {refused.length === 0 ? (
          <p className="mt-2 text-lg text-muted">{t('outbox.noRejected')}</p>
        ) : (
          <>
            <p className="mt-1 text-base text-ink-soft">{t('outbox.rejectedHelp')}</p>
            <ol className="mt-3 flex flex-col gap-2">
              {refused.map((c) => (
                <li key={c.client_uuid} className={`rounded-lg bg-paper px-3 py-2 ${c.acknowledged_at ? 'opacity-60' : ''}`}>
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-base font-bold">{c.rpc}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted">{formatTime(c.event_at)}</span>
                  </p>
                  <p className="text-lg font-bold text-brand-dark">{tDynamic(`errors.${c.error_code}`, 'errors.UNKNOWN')}</p>
                  <p className="break-words text-sm text-ink-soft">
                    {c.error_code} · {c.error_message}
                  </p>
                  {c.acknowledged_at ? null : (
                    <button
                      type="button"
                      onClick={() => void acknowledgeRejected(c.client_uuid)}
                      className="mt-2 min-h-12 w-full rounded-lg bg-ink text-base font-bold text-paper"
                    >
                      {t('outbox.acknowledge')}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </div>
  );
}
