'use client';

import { useState } from 'react';
import { palletSerialOf, type ClassifiedScan } from '@dayson/domain';
import { LabelPrint } from '@/components/floor/LabelPrint';
import { ScanInput } from '@/components/floor/ScanInput';
import { Banner, Card, Row, SectionTitle } from '@/components/floor/ui';
import { formatIsoDate, t, tDynamic } from '@/i18n';
import { scanLookup, type ScanLookup, type StockRow } from '@/lib/data/floor-read';
import { fmtKg, fmtQty } from '@/lib/floor/format';
import { KIND_LABEL, type ScanMeta } from '@/lib/floor/scan-flow';
import { useFloor } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

type View =
  | { state: 'found'; scan: ClassifiedScan; result: Exclude<ScanLookup, { kind: 'unknown' }> }
  | { state: 'unknown'; scan: ClassifiedScan }
  | { state: 'offline'; scan: ClassifiedScan }
  | { state: 'error'; scan: ClassifiedScan; text: string };

const statusText = (status: string | null | undefined) => tDynamic(`floor.status.${status ?? 'unknown'}`, 'floor.status.unknown');

function StockList({ rows, showLocation }: { rows: StockRow[]; showLocation: boolean }) {
  if (rows.length === 0) return <p className="py-2 text-base font-semibold text-muted">{t('floor.query.noStock')}</p>;
  return (
    <ul className="flex flex-col" data-testid="query-stock">
      {rows.map((s, i) => (
        <li key={i} className="border-t border-line py-2 first:border-t-0">
          <p className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-base font-extrabold">{showLocation ? s.location_code : s.sku}</span>
            <span className="text-lg font-extrabold tabular-nums">
              {fmtQty(s.qty_base)}
              {s.pallets ? <span className="ml-1 text-sm font-semibold text-muted">({t('floor.common.pallets', { n: fmtQty(s.pallets) })})</span> : null}
            </span>
          </p>
          <p className="text-sm text-ink-soft">
            {[
              showLocation ? null : s.item_name,
              s.lot_no ? `${t('scan.field.lot')} ${s.lot_no}` : null,
              s.expiry_date ? `${t('floor.common.expiryShort')} ${formatIsoDate(s.expiry_date)}` : null,
              statusText(s.stock_status),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Sorgu: scan anything to see what it is and where it is (rpc_scan_lookup). */
export function QueryScreen() {
  const { accept, refuse } = useFloor('query');
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);

  const onScan = async (scan: ClassifiedScan, meta: ScanMeta) => {
    if (busy) return;
    const serial = palletSerialOf(scan);
    const args =
      serial !== null
        ? { code: serial }
        : scan.kind === 'location'
          ? { code: scan.code }
          : scan.kind === 'gs1'
            ? { gtin: scan.data.gtin ?? null, lot_no: scan.data.lot ?? null }
            : { code: scan.raw.trim().toUpperCase() }; // e.g. a typed SKU
    setBusy(true);
    try {
      const result = await scanLookup(getBrowserSupabase(), args);
      if (result.kind === 'unknown') {
        refuse(scan, meta, 'unknown');
        setView({ state: 'unknown', scan });
      } else {
        accept(scan, meta);
        setView({ state: 'found', scan, result });
      }
    } catch (err) {
      const transient = !(err && typeof err === 'object' && 'transient' in err) || (err as { transient: boolean }).transient;
      if (scan.kind === 'unknown') refuse(scan, meta, 'unknown');
      else accept(scan, meta);
      setView(transient ? { state: 'offline', scan } : { state: 'error', scan, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const result = view?.state === 'found' ? view.result : null;

  return (
    <div className="flex flex-col gap-3">
      <ScanInput onScan={(scan, meta) => void onScan(scan, meta)} disabled={busy} showLast={false} />
      {!view ? <p className="px-1 text-lg text-muted">{t('floor.desc.query')}</p> : null}

      {view?.state === 'unknown' ? <Banner tone="bad">{t('floor.query.unknown')}</Banner> : null}
      {view?.state === 'error' ? <Banner tone="bad">{view.text}</Banner> : null}
      {view?.state === 'offline' ? (
        <>
          <Banner tone="warn" testid="offline-notice">
            {t('floor.query.offline')}
          </Banner>
          {view.scan.kind !== 'unknown' ? (
            <Card>
              <p className="pb-1 text-xl font-extrabold">{t(KIND_LABEL[view.scan.kind])}</p>
              <dl>
                {view.scan.kind === 'location' ? <Row label={t('scan.field.code')} value={view.scan.code} mono /> : null}
                {view.scan.kind === 'pallet_serial' ? <Row label={t('scan.field.serial')} value={view.scan.serial} mono /> : null}
                {view.scan.kind === 'gs1' ? (
                  <>
                    {view.scan.data.sscc ? <Row label={t('scan.field.serial')} value={view.scan.data.sscc} mono /> : null}
                    {view.scan.data.gtin ? <Row label={t('scan.field.gtin')} value={view.scan.data.gtin} mono /> : null}
                    {view.scan.data.lot ? <Row label={t('scan.field.lot')} value={view.scan.data.lot} mono /> : null}
                    {view.scan.data.expiry ? <Row label={t('scan.field.expiry')} value={formatIsoDate(view.scan.data.expiry)} /> : null}
                  </>
                ) : null}
              </dl>
            </Card>
          ) : null}
        </>
      ) : null}

      {result?.kind === 'pallet' ? (
        <>
          <Card className="border-ink" testid="query-pallet">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">{t('flow.pallet')}</p>
            <p className="font-mono text-xl font-extrabold">{result.pallet.serial}</p>
            <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-muted">{t('floor.common.location')}</p>
            <p className="font-mono text-4xl font-extrabold leading-tight" data-testid="query-location">
              {result.location ?? t('floor.query.notInWarehouse')}
            </p>
            <dl className="mt-2">
              <Row label={t('floor.common.item')} value={result.pallet.sku} testid="query-sku" />
              <Row label={t('floor.query.name')} value={result.pallet.name} />
              <Row label={t('scan.field.lot')} value={result.pallet.lot_no ?? '—'} mono testid="query-lot" />
              <Row label={t('scan.field.expiry')} value={result.pallet.expiry_date ? formatIsoDate(result.pallet.expiry_date) : '—'} />
              <Row label={t('floor.common.qty')} value={fmtQty(result.pallet.qty_base)} testid="query-qty" />
              <Row label={t('floor.query.weight')} value={fmtKg(result.pallet.kg)} />
              <Row label={t('floor.common.status')} value={statusText(result.stock_status ?? (result.pallet.status === 'active' ? null : result.pallet.status))} testid="query-status" />
              {result.pallet.shipment_id ? <Row label={t('floor.query.picked')} value={result.pallet.loaded_at ? t('floor.query.loaded') : t('floor.query.staged')} /> : null}
            </dl>
          </Card>
          <LabelPrint job={{ template: 'pallet', label: { ...result.pallet, qty_base: result.pallet.qty_base } }} title={t('floor.query.reprint')} />
        </>
      ) : null}

      {result?.kind === 'location' ? (
        <Card className="border-ink" testid="query-location-card">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">{tDynamic(`floor.locType.${result.location.type}`, 'floor.locType.other')}</p>
          <p className="font-mono text-3xl font-extrabold">{result.location.code}</p>
          <p className="mb-1 text-sm font-semibold text-ink-soft">{t('floor.query.palletCount', { n: result.pallets.length })}</p>
          <SectionTitle>{t('floor.query.contents')}</SectionTitle>
          <StockList rows={result.stock} showLocation={false} />
          {result.pallets.length > 0 ? (
            <>
              <SectionTitle>{t('floor.query.pallets')}</SectionTitle>
              <ul className="grid grid-cols-1 gap-1 pt-1">
                {result.pallets.map((p) => (
                  <li key={p.serial} className="flex justify-between gap-2 font-mono text-base">
                    <span>{p.serial}</span>
                    <span className="font-bold tabular-nums">{fmtQty(p.qty_base)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ) : null}

      {result?.kind === 'item' ? (
        <Card className="border-ink" testid="query-item">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">{t('floor.common.item')}</p>
          <p className="font-mono text-2xl font-extrabold">{result.item.sku}</p>
          <p className="mb-2 text-base text-ink-soft">{result.item.name}</p>
          <SectionTitle>{t('floor.query.stockByLot')}</SectionTitle>
          <StockList rows={result.stock} showLocation />
        </Card>
      ) : null}
    </div>
  );
}
