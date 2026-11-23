'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { palletSerialOf, type ClassifiedScan } from '@dayson/domain';
import { ScanInput } from '@/components/floor/ScanInput';
import { BigButton, Card, NoticeBanner, Row, StepList, notice, type Notice } from '@/components/floor/ui';
import { formatIsoDate, t, tDynamic } from '@/i18n';
import type { MoveResult, PutawaySuggestion } from '@/lib/data/floor-cmd';
import { scanLookup, type LookupPallet } from '@/lib/data/floor-read';
import { fmtQty } from '@/lib/floor/format';
import type { ScanMeta } from '@/lib/floor/scan-flow';
import { manualReasonOf, methodOf, useFloor, type FloorResult } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

interface Target {
  serial: string;
  meta: ScanMeta;
  /** Null while offline: the pallet is not known on this device. */
  pallet: LookupPallet | null;
  location: string | null;
  status: string | null;
  suggestion: PutawaySuggestion | null;
}

type Done = { status: 'done'; serial: string; to: string } | { status: 'queued'; serial: string; to: string };

/** Yerleştirme (spec 5.3): scan the pallet, see the suggested lane, scan the lane it is put in. */
export function PutawayScreen() {
  const floor = useFloor('putaway');
  const { run, accept, refuse } = floor;
  const params = useSearchParams();
  const taskId = params.get('task');
  const presetSerial = params.get('pallet');

  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const loadPallet = async (serial: string, meta: ScanMeta, scan: ClassifiedScan | null) => {
    setBusy(true);
    setDone(null);
    try {
      const found = await scanLookup(getBrowserSupabase(), { code: serial });
      if (found.kind !== 'pallet') {
        if (scan) refuse(scan, meta, 'UNKNOWN_PALLET', 'pallet');
        setMsg(notice('bad', t('floor.errors.UNKNOWN_PALLET')));
        return;
      }
      if (found.pallet.status !== 'active' || !found.location) {
        if (scan) refuse(scan, meta, 'INVALID_STATE', 'pallet');
        setMsg(notice('bad', t('floor.errors.INVALID_STATE')));
        return;
      }
      if (scan) accept(scan, meta, 'pallet');
      setMsg(null);
      setTarget({ serial, meta, pallet: found.pallet, location: found.location, status: found.stock_status, suggestion: found.putaway });
    } catch {
      // No connection: the move can still be queued; the server checks it on replay.
      if (scan) accept(scan, meta, 'pallet');
      setMsg(notice('warn', t('floor.putaway.offlineNoSuggestion')));
      setTarget({ serial, meta, pallet: null, location: null, status: null, suggestion: null });
    } finally {
      setBusy(false);
    }
  };

  // Opened from a task or from receiving: the pallet is already known.
  const preset = useRef(false);
  useEffect(() => {
    if (preset.current || !presetSerial || !/^\d{18}$/.test(presetSerial)) return;
    preset.current = true;
    const timer = window.setTimeout(() => void loadPallet(presetSerial, { method: 'scan' }, null), 0);
    return () => window.clearTimeout(timer);
    // loadPallet only uses stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSerial]);

  const settle = (serial: string, to: string) => (result: FloorResult<MoveResult>) => {
    if (result.status === 'rejected') {
      setDone(null);
      setMsg(notice('bad', result.text));
      return;
    }
    setMsg(null);
    setTarget(null);
    setDone(result.status === 'done' ? { status: 'done', serial, to: result.data.to_location ?? to } : { status: 'queued', serial, to });
  };

  const onScan = (scan: ClassifiedScan, meta: ScanMeta) => {
    if (busy) return;
    if (scan.kind === 'unknown') {
      refuse(scan, meta, 'unknown');
      setMsg(notice('bad', t('scan.refused.unknown')));
      return;
    }
    const serial = palletSerialOf(scan);
    if (!target) {
      if (!serial) {
        refuse(scan, meta, 'wrong_kind', 'pallet');
        setMsg(notice('bad', t('floor.putaway.scanPalletFirst')));
        return;
      }
      void loadPallet(serial, meta, scan);
      return;
    }
    if (scan.kind !== 'location') {
      // Another pallet: start over with it.
      if (serial) void loadPallet(serial, meta, scan);
      return;
    }
    if (target.location && scan.code === target.location) {
      refuse(scan, meta, 'same_location', 'destination');
      setMsg(notice('bad', t('floor.putaway.sameLocation')));
      return;
    }
    floor.log(scan, meta, 'accepted', 'destination');
    setBusy(true);
    const handler = settle(target.serial, scan.code);
    void run<MoveResult>(
      'putaway',
      {
        pallet_serial: target.serial,
        to_location: scan.code,
        from_location: target.location ?? undefined,
        task_id: taskId ?? undefined,
        scan_method: methodOf(target.meta, meta),
        reason_code: manualReasonOf(target.meta, meta),
      },
      { onLate: handler },
    ).then((result) => {
      handler(result);
      setBusy(false);
    });
  };

  const suggestion = target?.suggestion ?? null;

  return (
    <div className="flex flex-col gap-3">
      <StepList
        steps={[
          { key: 'pallet', label: t('flow.pallet'), state: target ? 'done' : 'current', value: target?.serial, hint: t('scan.waiting') },
          {
            key: 'destination',
            label: t('floor.putaway.lane'),
            state: target ? 'current' : 'pending',
            hint: suggestion?.location ? t('floor.putaway.suggestedShort', { code: suggestion.location }) : null,
          },
        ]}
      />
      <ScanInput onScan={onScan} disabled={busy} prompt={target ? t('floor.putaway.scanLane') : t('floor.putaway.scanPallet')} />
      <NoticeBanner value={msg} />

      {done ? (
        <div role="status" data-testid="putaway-done" className={`rounded-xl px-4 py-3 ${done.status === 'done' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
          <p className="text-lg font-extrabold">{done.status === 'done' ? t('floor.putaway.done') : t('floor.common.queued')}</p>
          <p className="font-mono text-xl font-extrabold">
            {done.serial} → {done.to}
          </p>
        </div>
      ) : null}

      {target ? (
        <>
          {target.pallet ? (
            <Card testid="putaway-suggestion" className="border-ink">
              <p className="text-sm font-semibold uppercase tracking-wide text-muted">{t('floor.putaway.suggested')}</p>
              <p className="font-mono text-4xl font-extrabold leading-tight" data-testid="putaway-lane">
                {suggestion?.location ?? '—'}
              </p>
              <p className="text-sm font-semibold text-ink-soft">{tDynamic(`floor.putaway.rule.${suggestion?.rule ?? 'other'}`, 'floor.putaway.rule.other')}</p>
              <p className="mt-1 text-sm text-muted">{t('floor.putaway.otherLaneAllowed')}</p>
            </Card>
          ) : null}
          {target.pallet ? (
            <Card>
              <dl>
                <Row label={t('floor.common.item')} value={target.pallet.sku} />
                <Row label={t('scan.field.lot')} value={target.pallet.lot_no ?? '—'} mono />
                <Row label={t('scan.field.expiry')} value={target.pallet.expiry_date ? formatIsoDate(target.pallet.expiry_date) : '—'} />
                <Row label={t('floor.common.qty')} value={fmtQty(target.pallet.qty_base)} />
                <Row label={t('floor.common.location')} value={target.location ?? '—'} mono />
                <Row label={t('floor.common.status')} value={tDynamic(`floor.status.${target.status ?? 'unknown'}`, 'floor.status.unknown')} />
              </dl>
            </Card>
          ) : null}
          <BigButton tone="ghost" onClick={() => { setTarget(null); setMsg(null); }}>
            {t('flow.restart')}
          </BigButton>
        </>
      ) : null}
    </div>
  );
}
