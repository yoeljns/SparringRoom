'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { BigButton, Card, ChoiceGrid, EmptyState, Loading, NoticeBanner, OfflineNotice, QueuedBanner, RefreshButton, Row, SectionTitle, notice, type Notice } from '@/components/floor/ui';
import { formatIsoDate, t } from '@/i18n';
import { listQcQueue, type QcRow } from '@/lib/data/floor-read';
import { fmtQty } from '@/lib/floor/format';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { useFloor } from '@/lib/floor/use-floor';

const REJECT_REASONS = ['failed_test', 'damaged', 'wrong_spec', 'contaminated', 'documents_missing', 'other'] as const;

function ageText(hours: number): string {
  if (hours >= 48) return t('floor.qc.ageDays', { d: Math.floor(hours / 24), h: Math.round(hours % 24) });
  return t('floor.qc.ageHours', { h: fmtQty(Math.round(hours * 10) / 10) });
}

/** Kalite (spec 5.3): quarantined lots with their age in hours; release or reject with a reason. */
export function QcScreen() {
  const { run } = useFloor('qc');
  const query = useCachedQuery('qc.queue', listQcQueue);
  const params = useSearchParams();
  const preselected = params.get('lot');

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [decision, setDecision] = useState<'release' | 'reject' | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [queuedKeys, setQueuedKeys] = useState<string[]>([]);

  const keyOf = (row: QcRow) => `${row.lot_id}.${row.stock_status}`;
  const rows = query.data ?? [];
  const current = openKey ?? (preselected ? (rows.find((r) => r.lot_id === preselected) ? keyOf(rows.find((r) => r.lot_id === preselected)!) : null) : null);

  const open = (row: QcRow) => {
    setOpenKey(keyOf(row));
    setDecision(null);
    setReason(null);
    setMsg(null);
  };

  const decide = async (row: QcRow) => {
    if (!decision || (decision === 'reject' && !reason)) return;
    setBusy(true);
    const result = await run('qc', {
      lot_id: row.lot_id,
      decision,
      reason_code: decision === 'reject' ? reason : undefined,
      // A lot blocked for expiry is released after a retest.
      from_status: row.stock_status === 'blocked_expiry' ? 'blocked_expiry' : undefined,
    });
    setBusy(false);
    if (result.status === 'rejected') {
      setMsg(notice('bad', result.text));
      return;
    }
    if (result.status === 'queued') setQueuedKeys((k) => [...k, keyOf(row)]);
    setMsg(notice('ok', t(decision === 'release' ? 'floor.qc.released' : 'floor.qc.rejected', { lot: row.lot_no })));
    setOpenKey('');
    setDecision(null);
    setReason(null);
    query.reload();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle count={rows.length}>{t('floor.qc.queue')}</SectionTitle>
        <RefreshButton onClick={query.reload} busy={query.loading} />
      </div>
      <OfflineNotice stale={query.stale} fetchedAt={query.fetchedAt} />
      <NoticeBanner value={msg} />
      {queuedKeys.length > 0 ? <QueuedBanner /> : null}
      {query.loading && !query.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState>{query.data ? t('floor.qc.empty') : t('floor.common.offlineNoData')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const key = keyOf(row);
            const isOpen = current === key;
            const waiting = queuedKeys.includes(key);
            return (
              <li key={key}>
                <Card className={isOpen ? 'border-ink' : ''} testid="qc-lot">
                  <button type="button" onClick={() => open(row)} className="flex min-h-14 w-full items-start justify-between gap-3 text-left" data-testid="qc-open" data-lot={row.lot_no}>
                    <span className="min-w-0">
                      <span className="block font-mono text-lg font-extrabold leading-tight">{row.lot_no}</span>
                      <span className="block truncate text-base font-semibold">{row.sku}</span>
                      <span className="block truncate text-sm text-ink-soft">{row.item_name}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={`block rounded-full px-2 py-1 text-sm font-extrabold ${row.age_hours >= 24 ? 'bg-brand text-paper' : 'bg-surface text-ink'}`} data-testid="qc-age">
                        {ageText(Number(row.age_hours))}
                      </span>
                      {row.stock_status === 'blocked_expiry' ? <span className="mt-1 block text-xs font-bold text-warn">{t('floor.status.blocked_expiry')}</span> : null}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="mt-2 flex flex-col gap-3">
                      <dl>
                        <Row label={t('floor.common.qty')} value={fmtQty(row.qty_base)} />
                        <Row label={t('scan.field.expiry')} value={row.expiry_date ? formatIsoDate(row.expiry_date) : '—'} />
                        <Row label={t('floor.common.location')} value={row.locations ?? '—'} mono />
                      </dl>
                      {waiting ? null : (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            <BigButton tone={decision === 'release' ? 'ok' : 'ghost'} onClick={() => setDecision('release')} data-testid="qc-release">
                              {t('floor.qc.release')}
                            </BigButton>
                            <BigButton tone={decision === 'reject' ? 'danger' : 'ghost'} onClick={() => setDecision('reject')} data-testid="qc-reject">
                              {t('floor.qc.reject')}
                            </BigButton>
                          </div>
                          {decision === 'reject' ? (
                            <ChoiceGrid
                              options={REJECT_REASONS.map((code) => ({ value: code, label: t(`floor.qc.reasons.${code}`) }))}
                              value={reason}
                              onChange={setReason}
                              label={t('floor.qc.rejectReason')}
                              testid="qc-reasons"
                            />
                          ) : null}
                          {decision ? (
                            <BigButton onClick={() => void decide(row)} disabled={busy || (decision === 'reject' && !reason)} data-testid="qc-confirm">
                              {decision === 'release' ? t('floor.qc.confirmRelease') : t('floor.qc.confirmReject')}
                            </BigButton>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
