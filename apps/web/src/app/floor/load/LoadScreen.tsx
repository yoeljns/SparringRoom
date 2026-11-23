'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { palletSerialOf, type ClassifiedScan } from '@dayson/domain';
import { ApprovalPanel } from '@/components/floor/ApprovalPanel';
import { BlockUntilDrained } from '@/components/floor/BlockUntilDrained';
import { ScanInput } from '@/components/floor/ScanInput';
import { BigButton, Card, EmptyState, Loading, NoticeBanner, OfflineNotice, RefreshButton, SectionTitle, TextField, notice, type Notice } from '@/components/floor/ui';
import { formatIsoDate, t, tDynamic } from '@/i18n';
import type { CloseTruckResult, TruckStatus } from '@/lib/data/floor-cmd';
import { listShipments, truckStatus, weightOverrideOf, type ApprovalRow } from '@/lib/data/floor-read';
import { fmtKg, fmtQty } from '@/lib/floor/format';
import type { ScanMeta } from '@/lib/floor/scan-flow';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { manualReasonOf, useFloor, type FloorResult } from '@/lib/floor/use-floor';

const OVERRIDE_REASONS = ['customer_request', 'partial_truck', 'scale_difference', 'other'] as const;

function windowText(s: TruckStatus): string {
  if (s.in_window) return t('floor.load.inWindow', { kg: fmtQty(s.to_max_kg) });
  if (s.to_min_kg > 0) return t('floor.load.belowWindow', { kg: fmtQty(s.to_min_kg) });
  return t('floor.load.aboveWindow', { kg: fmtQty(-s.to_max_kg) });
}

/** Yükleme (spec 5.4): scan the truck, then each pallet; running weight; truck close. */
export function LoadScreen() {
  const floor = useFloor('load');
  const { run, accept, refuse, online } = floor;
  const params = useSearchParams();

  const fetchShipments = useCallback((sb: Parameters<typeof listShipments>[0]) => listShipments(sb, ['picking', 'loading']), []);
  const shipmentsQuery = useCachedQuery('load.shipments', fetchShipments);

  const [shipmentId, setShipmentId] = useState<string | null>(params.get('shipment'));
  const fetchStatus = useCallback((sb: Parameters<typeof truckStatus>[0]) => truckStatus(sb, shipmentId ?? ''), [shipmentId]);
  const statusQuery = useCachedQuery(shipmentId ? `load.status.${shipmentId}` : null, fetchStatus);
  const fetchOverride = useCallback((sb: Parameters<typeof truckStatus>[0]) => weightOverrideOf(sb, shipmentId ?? ''), [shipmentId]);
  const overrideQuery = useCachedQuery(shipmentId ? `load.override.${shipmentId}` : null, fetchOverride);

  /** Status returned by the last load command: fresher than the query. */
  const [live, setLive] = useState<{ id: string; status: TruckStatus } | null>(null);
  /** Pallets scanned while offline, shown as loaded until the server answers. */
  const [pending, setPending] = useState<string[]>([]);
  const [eirsaliye, setEirsaliye] = useState<string | null>(null);
  const [seal, setSeal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [weightRefused, setWeightRefused] = useState(false);
  const [override, setOverride] = useState<ApprovalRow | null>(null);
  const [closed, setClosed] = useState<CloseTruckResult | 'queued' | null>(null);
  /** Refusal of the close itself, shown next to the close button. */
  const [closeMsg, setCloseMsg] = useState<Notice | null>(null);

  const shipments = useMemo(() => shipmentsQuery.data ?? [], [shipmentsQuery.data]);
  const shipment = shipments.find((s) => s.id === shipmentId) ?? null;
  const base = live && live.id === shipmentId ? live.status : statusQuery.data;
  const status = useMemo<TruckStatus | null>(() => {
    if (!base) return null;
    if (pending.length === 0) return base;
    const pallets = base.pallets.map((p) => (pending.includes(p.serial) ? { ...p, loaded: true } : p));
    return { ...base, pallets, pallets_loaded: pallets.filter((p) => p.loaded).length };
  }, [base, pending]);

  const eirsValue = eirsaliye ?? status?.e_irsaliye_no ?? shipment?.e_irsaliye_no ?? '';
  const overrideRow = override ?? overrideQuery.data ?? null;

  const choose = (id: string) => {
    setShipmentId(id);
    setLive(null);
    setPending([]);
    setEirsaliye(null);
    setSeal('');
    setMsg(null);
    setWeightRefused(false);
    setOverride(null);
    setClosed(null);
    setCloseMsg(null);
  };

  const settleLoad = (serial: string) => (result: FloorResult<TruckStatus>) => {
    if (result.status === 'done') {
      setPending((list) => list.filter((s) => s !== serial));
      if (shipmentId) setLive({ id: shipmentId, status: result.data });
      setMsg(notice('ok', t('floor.load.loaded', { serial: serial.slice(-6) })));
    } else if (result.status === 'queued') {
      setPending((list) => (list.includes(serial) ? list : [...list, serial]));
      setMsg(notice('warn', t('floor.common.queued')));
    } else {
      setPending((list) => list.filter((s) => s !== serial));
      setMsg(notice('bad', result.text));
    }
  };

  const onScan = (scan: ClassifiedScan, meta: ScanMeta) => {
    if (busy) return;
    if (!shipmentId) {
      // Truck: its shipment number is matched on the raw text.
      const raw = scan.raw.trim().toUpperCase();
      const hit = shipments.find((s) => s.shipment_no.toUpperCase() === raw);
      if (!hit) {
        refuse(scan, meta, 'unknown_truck', 'source');
        setMsg(notice('bad', t('floor.load.truckNotFound')));
        return;
      }
      accept(scan, meta, 'source');
      choose(hit.id);
      return;
    }
    const serial = palletSerialOf(scan);
    if (!serial) {
      refuse(scan, meta, scan.kind === 'unknown' ? 'unknown' : 'wrong_kind', 'pallet');
      setMsg(notice('bad', scan.kind === 'unknown' ? t('scan.refused.unknown') : t('floor.load.scanPalletOnly')));
      return;
    }
    if (status && !status.pallets.some((p) => p.serial === serial)) {
      // Known list, pallet not on it: refuse at once (the server would answer WRONG_TRUCK).
      refuse(scan, meta, 'WRONG_TRUCK', 'pallet');
      setMsg(notice('bad', t('floor.errors.WRONG_TRUCK')));
      return;
    }
    floor.log(scan, meta, 'accepted', 'pallet');
    setBusy(true);
    const handler = settleLoad(serial);
    void run<TruckStatus>(
      'load',
      { shipment_id: shipmentId, pallet_serial: serial, scan_method: meta.method, reason_code: manualReasonOf(meta) },
      { onLate: handler },
    ).then((result) => {
      handler(result);
      setBusy(false);
    });
  };

  const close = async () => {
    if (!shipmentId) return;
    setBusy(true);
    setCloseMsg(null);
    const result = await run<CloseTruckResult>(
      'close_truck',
      { shipment_id: shipmentId, e_irsaliye_no: eirsValue.trim(), seal_no: seal.trim() || undefined },
      { waitMs: 20000 },
    );
    setBusy(false);
    if (result.status === 'done') {
      setClosed(result.data);
      setMsg(null);
      shipmentsQuery.reload();
    } else if (result.status === 'queued') {
      setClosed('queued');
    } else {
      if (result.code === 'WEIGHT_OUT_OF_WINDOW') setWeightRefused(true);
      setCloseMsg(notice('bad', result.text));
      statusQuery.reload();
    }
  };

  // ---- truck list -------------------------------------------------------------

  if (!shipmentId) {
    return (
      <div className="flex flex-col gap-3">
        <ScanInput onScan={onScan} allowManual={false} showLast={false} prompt={t('floor.load.scanTruck')} />
        <NoticeBanner value={msg} />
        <div className="flex items-center justify-between gap-2">
          <SectionTitle count={shipments.length}>{t('floor.load.trucks')}</SectionTitle>
          <RefreshButton onClick={shipmentsQuery.reload} busy={shipmentsQuery.loading} />
        </div>
        <OfflineNotice stale={shipmentsQuery.stale} fetchedAt={shipmentsQuery.fetchedAt} />
        {shipmentsQuery.loading && !shipmentsQuery.data ? (
          <Loading />
        ) : shipments.length === 0 ? (
          <EmptyState>{shipmentsQuery.data ? t('floor.load.empty') : t('floor.common.offlineNoData')}</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {shipments.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid="load-truck"
                  data-shipment={s.shipment_no}
                  onClick={() => choose(s.id)}
                  className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border-2 border-ink bg-paper px-3 py-2 text-left active:bg-surface"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xl font-extrabold">{s.shipment_no}</span>
                    <span className="block truncate text-base text-ink-soft">
                      {s.party_name ?? ''}
                      {s.planned_date ? ` · ${formatIsoDate(s.planned_date)}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-lg font-extrabold tabular-nums">
                      {s.pallets_loaded} / {s.pallets_picked}
                    </span>
                    <span className="block text-sm font-semibold text-muted">{tDynamic(`floor.load.state.${s.state}`, 'floor.load.state.other')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- closed -----------------------------------------------------------------

  if (closed) {
    return (
      <div className="flex flex-col gap-3">
        {closed === 'queued' ? (
          <div role="status" className="rounded-xl bg-warn-soft px-4 py-3 text-lg font-bold text-warn">
            {t('floor.common.queued')}
          </div>
        ) : (
          <div role="status" data-testid="truck-closed" className="rounded-xl bg-ok-soft px-4 py-4 text-ok">
            <p className="text-2xl font-extrabold">{t('floor.load.dispatched')}</p>
            <p className="font-mono text-xl font-extrabold">{shipment?.shipment_no ?? ''}</p>
            <p className="mt-1 text-lg font-bold">{fmtKg(Number(closed.loaded_kg))}</p>
            {closed.weight_override ? <p className="text-base font-bold text-warn">{t('floor.load.closedWithOverride')}</p> : null}
          </div>
        )}
        <BigButton
          onClick={() => {
            setShipmentId(null);
            setClosed(null);
            setMsg(null);
          }}
        >
          {t('floor.load.otherTruck')}
        </BigButton>
      </div>
    );
  }

  // ---- one truck ----------------------------------------------------------------

  const unscanned = status?.pallets.filter((p) => !p.loaded) ?? [];
  const allLoaded = !!status && status.pallets_total > 0 && unscanned.length === 0;
  const overrideApproved = overrideRow?.state === 'approved';
  const showOverride = !!status && !status.in_window && (weightRefused || !!overrideRow);
  const closeProblem = !eirsValue.trim()
    ? t('floor.errors.EIRSALIYE_REQUIRED')
    : status && status.pallets_total === 0
      ? t('floor.errors.NOTHING_TO_DO')
      : status && !allLoaded
        ? t('floor.load.unscannedLeft', { n: unscanned.length })
        : null;

  return (
    <div className="flex flex-col gap-3">
      <Card className="border-ink" testid="truck-panel">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-xl font-extrabold" data-testid="truck-no">
              {shipment?.shipment_no ?? '—'}
            </p>
            <p className="truncate text-base text-ink-soft">{shipment?.party_name ?? ''}</p>
          </div>
          <button type="button" onClick={() => setShipmentId(null)} className="min-h-12 shrink-0 rounded-lg border-2 border-line-strong bg-paper px-3 text-sm font-bold">
            {t('floor.load.otherTruck')}
          </button>
        </div>
        {status ? (
          <>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-surface px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-muted">{t('floor.load.palletsLoaded')}</p>
                <p className="text-3xl font-extrabold tabular-nums" data-testid="truck-pallets">
                  {status.pallets_loaded} / {status.pallets_total}
                </p>
              </div>
              <div className="rounded-lg bg-surface px-3 py-2">
                <p className="text-xs font-bold uppercase tracking-wide text-muted">{t('floor.load.runningKg')}</p>
                <p className="text-3xl font-extrabold tabular-nums" data-testid="truck-kg">
                  {fmtQty(status.loaded_kg)}
                </p>
              </div>
            </div>
            <p
              data-testid="truck-window"
              data-in-window={status.in_window}
              className={`mt-2 rounded-lg px-3 py-2 text-lg font-extrabold ${status.in_window ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand-dark'}`}
            >
              {windowText(status)}
              <span className="block text-sm font-semibold text-ink-soft">
                {t('floor.load.window', { min: fmtQty(status.min_kg), max: fmtQty(status.max_kg) })}
              </span>
            </p>
            {status.unpicked_qty > 0 ? <p className="mt-1 text-base font-bold text-warn">{t('floor.load.unpicked', { qty: fmtQty(status.unpicked_qty) })}</p> : null}
          </>
        ) : statusQuery.loading ? (
          <Loading />
        ) : (
          <p className="mt-2 text-base font-semibold text-muted">{t('floor.common.offlineNoData')}</p>
        )}
      </Card>
      <OfflineNotice stale={statusQuery.stale || (!online && !!status)} fetchedAt={statusQuery.fetchedAt} />

      <ScanInput onScan={onScan} disabled={busy} prompt={t('floor.load.scanPallet')} />
      <NoticeBanner value={msg} />

      {status ? (
        <>
          <SectionTitle count={unscanned.length}>{t('floor.load.unscanned')}</SectionTitle>
          {unscanned.length === 0 ? (
            <p className="rounded-xl bg-ok-soft px-3 py-2 text-base font-bold text-ok" data-testid="all-loaded">
              {status.pallets_total > 0 ? t('floor.load.allLoaded') : t('floor.errors.NOTHING_TO_DO')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="unscanned-list">
              {unscanned.map((p) => (
                <li key={p.serial} className="flex min-h-12 items-center justify-between gap-2 rounded-lg border border-line bg-paper px-3 py-1">
                  <span className="min-w-0">
                    <span className="block font-mono text-base font-bold">{p.serial}</span>
                    <span className="block truncate text-sm text-ink-soft">
                      {p.sku} · {p.lot_no ?? '—'}
                    </span>
                  </span>
                  <span className="shrink-0 text-base font-bold tabular-nums">{fmtKg(p.kg)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <Card testid="truck-close">
        <div className="flex flex-col gap-3">
          <TextField label={t('floor.load.eirsaliye')} value={eirsValue} onChange={setEirsaliye} testid="eirsaliye" uppercase placeholder={t('floor.load.eirsaliyeHint')} />
          <TextField label={t('floor.load.seal')} value={seal} onChange={setSeal} testid="seal" uppercase />
          {showOverride ? (
            <ApprovalPanel
              type="weight_override"
              payload={{ shipment_id: shipmentId }}
              title={t('floor.load.overrideTitle')}
              body={t('floor.load.overrideBody')}
              reasons={OVERRIDE_REASONS.map((code) => ({ value: code, label: t(`floor.load.overrideReasons.${code}`) }))}
              find={(sb) => weightOverrideOf(sb, shipmentId)}
              onChange={setOverride}
            />
          ) : null}
          <NoticeBanner value={closeMsg} testid="close-notice" />
          <BlockUntilDrained>
            {closeProblem ? <p className="text-base font-bold text-brand-dark">{closeProblem}</p> : null}
            <BigButton tone="danger" onClick={() => void close()} disabled={busy || !!closeProblem} data-testid="close-truck">
              {busy ? t('floor.common.sending') : overrideApproved && status && !status.in_window ? t('floor.load.closeWithOverride') : t('floor.load.close')}
            </BigButton>
          </BlockUntilDrained>
        </div>
      </Card>
    </div>
  );
}
