'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import { ApprovalPanel } from '@/components/floor/ApprovalPanel';
import { LabelPrint } from '@/components/floor/LabelPrint';
import { ScanInput } from '@/components/floor/ScanInput';
import {
  BigButton,
  Card,
  ChoiceGrid,
  EmptyState,
  Loading,
  NoticeBanner,
  OfflineNotice,
  QueuedBanner,
  Row,
  SectionTitle,
  StepList,
  TextField,
  notice,
  type Notice,
} from '@/components/floor/ui';
import { formatIsoDate, t, tDynamic } from '@/i18n';
import type { ReceiveResult } from '@/lib/data/floor-cmd';
import {
  approvalById,
  findLot,
  listDealersFor,
  listItems,
  listLocations,
  listReceiveDocs,
  type ApprovalRow,
  type ItemRow,
  type PartyRow,
  type ReceiveDoc,
} from '@/lib/data/floor-read';
import { useProfile } from '@/lib/auth/profile-context';
import { fmtQty, parseQty, uomLabel } from '@/lib/floor/format';
import type { ScanMeta } from '@/lib/floor/scan-flow';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { manualReasonOf, methodOf, useFloor, type FloorResult } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

type Tab = 'po_line' | 'production_order' | 'return';
type ReturnType = 'customer_return' | 'consign_return';

/** What is being received against. */
type Source =
  | { kind: 'doc'; doc: ReceiveDoc }
  | { kind: 'return'; docType: ReturnType; party: PartyRow; item: ItemRow };

interface PalletForm {
  lot_no: string;
  prod_date: string;
  expiry_date: string;
  qty: string;
  uom: 'pallet' | 'carton' | 'piece';
  kg: string;
  /** (00) of the supplier label, if it carried one. */
  serial: string;
  /** (01) of the supplier label; the server checks it against the document. */
  gtin: string;
}

const EMPTY_FORM: PalletForm = { lot_no: '', prod_date: '', expiry_date: '', qty: '1', uom: 'pallet', kg: '', serial: '', gtin: '' };

type Outcome =
  | { status: 'done'; data: ReceiveResult }
  | { status: 'queued' }
  | { status: 'rejected'; text: string };

const sameGtin = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace(/^0+/, '') === b.replace(/^0+/, '');

const APPROVAL_KEY = 'dayson.floor.overreceipt.';

function sourceItem(source: Source): { id: string; sku: string; name: string; gtin: string | null; base_uom: string; lot_controlled: boolean } {
  if (source.kind === 'doc') {
    const d = source.doc;
    return { id: d.item_id, sku: d.sku, name: d.item_name, gtin: d.gtin, base_uom: d.base_uom, lot_controlled: d.lot_controlled };
  }
  const i = source.item;
  return { id: i.id, sku: i.sku, name: i.name, gtin: i.gtin, base_uom: i.base_uom, lot_controlled: i.lot_expiry_controlled };
}

/** Mal Kabul (spec 5.2): document, pallet data (GS1 label or typed), weighed kg for the first pallet of a lot, dock scan. */
export function ReceiveScreen() {
  const floor = useFloor('receive');
  const { run, accept, refuse } = floor;
  const { profile, role } = useProfile();

  const docsQuery = useCachedQuery('receive.docs', listReceiveDocs);
  const locationsQuery = useCachedQuery('locations', listLocations);
  const dealersFetcher = useCallback((sb: Parameters<typeof listItems>[0]) => listDealersFor(sb, profile?.id ?? null, role), [profile?.id, role]);

  const [tab, setTab] = useState<Tab>('po_line');
  const [docFilter, setDocFilter] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [returnType, setReturnType] = useState<ReturnType>('customer_return');
  const [returnParty, setReturnParty] = useState<PartyRow | null>(null);
  const dealersQuery = useCachedQuery(tab === 'return' ? 'dealers' : null, dealersFetcher);
  const itemsQuery = useCachedQuery(tab === 'return' ? 'items' : null, listItems);

  const [form, setForm] = useState<PalletForm>(EMPTY_FORM);
  const [labelMeta, setLabelMeta] = useState<ScanMeta | null>(null);
  const [weightNeeded, setWeightNeeded] = useState(false);
  const [lotKnown, setLotKnown] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approval, setApproval] = useState<ApprovalRow | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [received, setReceived] = useState(0);

  const item = source ? sourceItem(source) : null;
  const docId = source?.kind === 'doc' ? source.doc.doc_id : null;
  const needsWeightCheck = source?.kind === 'doc' && form.uom === 'pallet';

  // Is this the first pallet of the lot? Then the weighed kg is mandatory (spec 5.2.3).
  const lotNo = form.lot_no.trim();
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!itemId || !lotNo) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void findLot(getBrowserSupabase(), itemId, lotNo)
        .then((lot) => {
          if (cancelled) return;
          setLotKnown(!!lot);
          setWeightNeeded(!lot || lot.actual_pallet_kg === null);
          if (lot) {
            // An existing lot keeps its dates: a different expiry would be refused.
            setForm((f) =>
              f.lot_no.trim() === lotNo ? { ...f, expiry_date: lot.expiry_date ?? f.expiry_date, prod_date: lot.prod_date ?? f.prod_date } : f,
            );
          }
        })
        .catch(() => {
          // Offline: the server decides and answers WEIGHT_REQUIRED on replay.
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [itemId, lotNo]);

  const startSource = (next: Source) => {
    setSource(next);
    setForm(EMPTY_FORM);
    setLabelMeta(null);
    setWeightNeeded(false);
    setLotKnown(false);
    setOutcome(null);
    setMsg(null);
    setNeedsApproval(false);
    setApproval(null);
    setReceived(0);
    let stored: string | null = null;
    if (next.kind === 'doc') {
      try {
        stored = window.localStorage.getItem(APPROVAL_KEY + next.doc.doc_id);
      } catch {
        stored = null;
      }
    }
    setApprovalId(stored);
    setNeedsApproval(!!stored);
  };

  const leaveSource = () => {
    setSource(null);
    setOutcome(null);
    setMsg(null);
    setDocFilter(null);
    docsQuery.reload();
  };

  // ---- document step -------------------------------------------------------

  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  const shownDocs = docs.filter((d) => d.doc_type === tab && (!docFilter || d.doc_no === docFilter));

  const onDocScan = (scan: ClassifiedScan, meta: ScanMeta) => {
    // A document number such as PO-2026-00001 has the shape of a location code, so match on the raw text.
    const raw = scan.raw.trim().toUpperCase();
    const hits = docs.filter((d) => d.doc_no.toUpperCase() === raw);
    if (hits.length === 0) {
      refuse(scan, meta, 'unknown_document');
      setMsg(notice('bad', t('floor.receive.docNotFound', { code: raw.slice(0, 30) })));
      return;
    }
    accept(scan, meta);
    setMsg(null);
    if (hits.length === 1) startSource({ kind: 'doc', doc: hits[0] });
    else {
      setTab(hits[0].doc_type);
      setDocFilter(hits[0].doc_no);
    }
  };

  // ---- pallet + dock step ---------------------------------------------------

  const formProblem = (): string | null => {
    if (!item) return t('floor.receive.formIncomplete');
    const qty = parseQty(form.qty);
    if (qty === null || qty <= 0) return t('floor.receive.qtyRequired');
    if (item.lot_controlled) {
      if (!lotNo) return t('floor.receive.lotRequired');
      if (!lotKnown && (!form.prod_date || !form.expiry_date)) return t('floor.receive.datesRequired');
      if (form.prod_date && form.expiry_date && form.expiry_date <= form.prod_date) return t('floor.receive.datesOrder');
    }
    if (needsWeightCheck && weightNeeded) {
      const kg = parseQty(form.kg);
      if (kg === null || kg <= 0) return t('floor.receive.weightRequired');
    }
    if (form.kg && (parseQty(form.kg) === null || (parseQty(form.kg) ?? 0) <= 0)) return t('floor.receive.weightRequired');
    return null;
  };

  const settle = (result: FloorResult<ReceiveResult>) => {
    if (result.status === 'done') {
      setOutcome({ status: 'done', data: result.data });
      setReceived((n) => n + 1);
      setNeedsApproval(false);
      setMsg(null);
      return;
    }
    if (result.status === 'queued') {
      setOutcome({ status: 'queued' });
      return;
    }
    setOutcome(null);
    if (result.code === 'WEIGHT_REQUIRED') setWeightNeeded(true);
    if (result.code === 'APPROVAL_REQUIRED') setNeedsApproval(true);
    setMsg(notice('bad', result.text));
  };

  const post = async (dock: string, dockMeta: ScanMeta) => {
    if (!source || !item) return;
    setBusy(true);
    const kg = parseQty(form.kg);
    const firstWeight = needsWeightCheck && weightNeeded;
    const args: Record<string, unknown> = {
      doc_type: source.kind === 'doc' ? source.doc.doc_type : source.docType,
      doc_id: source.kind === 'doc' ? source.doc.doc_id : undefined,
      item_id: source.kind === 'return' ? source.item.id : undefined,
      party_id: source.kind === 'return' ? source.party.id : undefined,
      gtin: form.gtin || undefined,
      lot_no: lotNo || undefined,
      prod_date: form.prod_date || undefined,
      expiry_date: form.expiry_date || undefined,
      qty: parseQty(form.qty) ?? 1,
      uom: form.uom === 'piece' ? item.base_uom : form.uom,
      to_location: dock,
      pallet_serial: form.serial || undefined,
      // The first pallet's weight is stored on the lot; later ones only on the pallet.
      actual_pallet_kg: kg && firstWeight ? kg : undefined,
      this_pallet_kg: kg && !firstWeight ? kg : undefined,
      approval_id: approval?.state === 'approved' ? approval.id : undefined,
      scan_method: methodOf(labelMeta, dockMeta),
      reason_code: manualReasonOf(labelMeta, dockMeta),
    };
    const result = await run<ReceiveResult>('receive', args, { onLate: settle });
    settle(result);
    setBusy(false);
  };

  const onPalletScan = (scan: ClassifiedScan, meta: ScanMeta) => {
    if (!item || busy) return;
    if (scan.kind === 'unknown') {
      refuse(scan, meta, 'unknown');
      setMsg(notice('bad', t('scan.refused.unknown')));
      return;
    }
    if (scan.kind === 'gs1') {
      // Supplier label: prefill item check, lot, dates and the pallet serial.
      if (scan.data.gtin && item.gtin && !sameGtin(scan.data.gtin, item.gtin)) {
        refuse(scan, meta, 'WRONG_ITEM', 'pallet');
        setMsg(notice('bad', t('floor.errors.WRONG_ITEM')));
        return;
      }
      accept(scan, meta, 'pallet');
      setLabelMeta(meta);
      setMsg(notice('ok', t('floor.receive.labelRead')));
      setForm((f) => ({
        ...f,
        gtin: scan.data.gtin ?? f.gtin,
        lot_no: scan.data.lot ?? f.lot_no,
        prod_date: scan.data.productionDate ?? f.prod_date,
        expiry_date: scan.data.expiry ?? f.expiry_date,
        serial: scan.data.sscc ?? f.serial,
      }));
      return;
    }
    if (scan.kind === 'pallet_serial') {
      accept(scan, meta, 'pallet');
      setLabelMeta(meta);
      setForm((f) => ({ ...f, serial: scan.serial }));
      setMsg(notice('ok', t('floor.receive.serialRead')));
      return;
    }
    // A location: this is the dock, the confirming scan.
    const known = locationsQuery.data?.find((l) => l.code === scan.code);
    if (locationsQuery.data && (!known || known.type !== 'dock')) {
      refuse(scan, meta, 'not_a_dock', 'destination');
      setMsg(notice('bad', t('floor.receive.notDock', { code: scan.code })));
      return;
    }
    const problem = formProblem();
    if (problem) {
      refuse(scan, meta, 'form_incomplete', 'destination');
      setMsg(notice('bad', problem));
      return;
    }
    if (needsApproval && approval?.state !== 'approved' && role !== 'ops_manager' && role !== 'owner') {
      refuse(scan, meta, 'APPROVAL_REQUIRED', 'destination');
      setMsg(notice('bad', t('floor.receive.approvalFirst')));
      return;
    }
    floor.log(scan, meta, 'accepted', 'destination');
    void post(scan.code, meta);
  };

  const nextPallet = () => {
    // Same document and lot: keep lot and dates, ask for the next pallet.
    setForm((f) => ({ ...f, serial: '', kg: '', gtin: '' }));
    setLabelMeta(null);
    setWeightNeeded(false);
    setOutcome(null);
    setMsg(null);
  };

  // ---- render ---------------------------------------------------------------

  if (!source) {
    const tabs = [
      { value: 'po_line' as const, label: t('floor.receive.tabPurchase') },
      { value: 'production_order' as const, label: t('floor.receive.tabProduction') },
      { value: 'return' as const, label: t('floor.receive.tabReturn') },
    ];
    return (
      <div className="flex flex-col gap-3">
        <ChoiceGrid options={tabs} value={tab} onChange={(v) => { setTab(v); setDocFilter(null); setMsg(null); }} label={t('floor.receive.docType')} columns={3} testid="receive-tabs" />
        {tab !== 'return' ? (
          <>
            <ScanInput onScan={onDocScan} allowManual={false} showLast={false} prompt={t('floor.receive.scanDoc')} />
            <NoticeBanner value={msg} />
            <OfflineNotice stale={docsQuery.stale} fetchedAt={docsQuery.fetchedAt} />
            <SectionTitle count={shownDocs.length}>{t('floor.receive.openDocs')}</SectionTitle>
            {docsQuery.loading && !docsQuery.data ? (
              <Loading />
            ) : shownDocs.length === 0 ? (
              <EmptyState>{t('floor.receive.noDocs')}</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {shownDocs.map((d) => (
                  <li key={d.doc_id}>
                    <button
                      type="button"
                      data-testid="receive-doc"
                      data-doc-no={d.doc_no}
                      onClick={() => startSource({ kind: 'doc', doc: d })}
                      className="flex min-h-16 w-full flex-col items-start rounded-xl border-2 border-line bg-paper px-3 py-2 text-left active:bg-surface"
                    >
                      <span className="flex w-full items-baseline justify-between gap-2">
                        <span className="font-mono text-lg font-extrabold">
                          {d.doc_no}
                          {d.line_no ? ` / ${d.line_no}` : ''}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-ink-soft">
                          {fmtQty(d.received_qty)} / {fmtQty(d.qty)} {uomLabel(d.base_uom)}
                        </span>
                      </span>
                      <span className="block w-full truncate text-base font-semibold">{d.sku}</span>
                      <span className="block w-full truncate text-sm text-ink-soft">
                        {d.item_name}
                        {d.partner ? ` · ${d.partner}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <ChoiceGrid
              options={[
                { value: 'customer_return' as const, label: t('floor.receive.customerReturn') },
                { value: 'consign_return' as const, label: t('floor.receive.consignReturn') },
              ]}
              value={returnType}
              onChange={setReturnType}
              label={t('floor.receive.returnType')}
            />
            <OfflineNotice stale={dealersQuery.stale || itemsQuery.stale} fetchedAt={dealersQuery.fetchedAt} />
            {!returnParty ? (
              <>
                <SectionTitle>{t('floor.receive.chooseDealer')}</SectionTitle>
                {dealersQuery.loading && !dealersQuery.data ? <Loading /> : null}
                <ul className="flex flex-col gap-2">
                  {(dealersQuery.data ?? [])
                    .filter((p) => returnType === 'customer_return' || p.consignment)
                    .map((p) => (
                      <li key={p.id}>
                        <BigButton tone="ghost" className="justify-start text-left" onClick={() => setReturnParty(p)} data-testid="return-dealer">
                          {p.name}
                        </BigButton>
                      </li>
                    ))}
                </ul>
              </>
            ) : (
              <>
                <Card>
                  <dl>
                    <Row label={t('floor.receive.dealer')} value={returnParty.name} />
                  </dl>
                  <BigButton tone="ghost" className="mt-2" onClick={() => setReturnParty(null)}>
                    {t('floor.common.change')}
                  </BigButton>
                </Card>
                <SectionTitle>{t('floor.receive.chooseItem')}</SectionTitle>
                {itemsQuery.loading && !itemsQuery.data ? <Loading /> : null}
                <ul className="flex flex-col gap-2">
                  {(itemsQuery.data ?? []).map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        data-testid="return-item"
                        onClick={() => startSource({ kind: 'return', docType: returnType, party: returnParty, item: i })}
                        className="flex min-h-14 w-full flex-col items-start rounded-xl border-2 border-line bg-paper px-3 py-2 text-left active:bg-surface"
                      >
                        <span className="font-mono text-base font-extrabold">{i.sku}</span>
                        <span className="text-sm text-ink-soft">{i.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  if (!item) return null;
  const doc = source.kind === 'doc' ? source.doc : null;
  const header = (
    <Card testid="receive-header">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-lg font-extrabold">
          {doc ? `${doc.doc_no}${doc.line_no ? ` / ${doc.line_no}` : ''}` : source.kind === 'return' && source.docType === 'consign_return' ? t('floor.receive.consignReturn') : t('floor.receive.customerReturn')}
        </p>
        {doc ? (
          <p className="text-sm font-bold tabular-nums text-ink-soft" data-testid="receive-progress">
            {fmtQty(doc.received_qty)} / {fmtQty(doc.qty)} {uomLabel(doc.base_uom)}
          </p>
        ) : null}
      </div>
      <p className="text-base font-bold">{item.sku}</p>
      <p className="text-sm text-ink-soft">
        {item.name}
        {source.kind === 'return' ? ` · ${source.party.name}` : ''}
      </p>
      {received > 0 ? <p className="mt-1 text-sm font-bold text-ok">{t('floor.receive.receivedNow', { n: received })}</p> : null}
    </Card>
  );

  if (outcome) {
    const data = outcome.status === 'done' ? outcome.data : null;
    return (
      <div className="flex flex-col gap-3">
        {header}
        {outcome.status === 'queued' ? <QueuedBanner /> : null}
        {data ? (
          <>
            <div role="status" data-testid="receive-done" className="rounded-xl bg-ok-soft px-4 py-3 text-ok">
              <p className="text-lg font-extrabold">{t('floor.receive.done')}</p>
              <p className="font-mono text-xl font-extrabold" data-testid="receive-serial">
                {data.pallet_serial}
              </p>
              <p className="text-base font-semibold">
                {data.label?.lot_no ? `${t('scan.field.lot')} ${data.label.lot_no} · ` : ''}
                {t('floor.status.quarantine')}
              </p>
            </div>
            {data.label ? <LabelPrint job={{ template: 'pallet', label: data.label }} auto /> : null}
            {data.putaway ? (
              <Card testid="receive-putaway">
                <p className="text-sm font-semibold uppercase tracking-wide text-muted">{t('floor.putaway.suggested')}</p>
                <p className="font-mono text-3xl font-extrabold" data-testid="putaway-lane">
                  {data.putaway.location ?? '—'}
                </p>
                <p className="text-sm font-semibold text-ink-soft">{tDynamic(`floor.putaway.rule.${data.putaway.rule}`, 'floor.putaway.rule.other')}</p>
                <Link
                  href={`/floor/putaway?pallet=${data.pallet_serial}`}
                  className="mt-2 flex min-h-14 w-full items-center justify-center rounded-xl border-2 border-line-strong bg-paper text-lg font-bold"
                >
                  {t('floor.receive.goPutaway')}
                </Link>
              </Card>
            ) : null}
          </>
        ) : null}
        <BigButton onClick={nextPallet} data-testid="receive-next">
          {t('floor.receive.nextPallet')}
        </BigButton>
        <BigButton tone="ghost" onClick={leaveSource} data-testid="receive-finish">
          {t('floor.receive.finish')}
        </BigButton>
      </div>
    );
  }

  const uoms = [
    { value: 'pallet' as const, label: t('floor.uom.pallet') },
    { value: 'carton' as const, label: t('floor.uom.carton') },
    { value: 'piece' as const, label: uomLabel(item.base_uom) },
  ];
  const palletReady = formProblem() === null;

  return (
    <div className="flex flex-col gap-3">
      {header}
      <StepList
        steps={[
          {
            key: 'pallet',
            label: t('floor.receive.stepPallet'),
            state: palletReady ? 'done' : 'current',
            value: palletReady ? [lotNo, form.expiry_date ? formatIsoDate(form.expiry_date) : null].filter(Boolean).join(' · ') || form.qty : null,
            hint: t('floor.receive.stepPalletHint'),
          },
          { key: 'dock', label: t('floor.receive.stepDock'), state: palletReady ? 'current' : 'pending', hint: palletReady ? t('scan.waiting') : null },
        ]}
      />
      <ScanInput onScan={onPalletScan} disabled={busy} prompt={palletReady ? t('floor.receive.scanDock') : t('floor.receive.scanLabel')} />
      <NoticeBanner value={msg} />

      {needsApproval && docId ? (
        <ApprovalPanel
          type="over_receipt"
          payload={{ doc_type: doc?.doc_type, doc_id: docId, doc_no: doc?.doc_no, sku: item.sku, lot_no: lotNo, qty: parseQty(form.qty) ?? 1, uom: form.uom }}
          title={t('floor.receive.overTitle')}
          body={t('floor.receive.overBody')}
          reasons={[
            { value: 'supplier_overship', label: t('floor.receive.overReasons.supplier_overship') },
            { value: 'order_qty_wrong', label: t('floor.receive.overReasons.order_qty_wrong') },
            { value: 'other', label: t('scan.reasons.other') },
          ]}
          find={(sb) => (approvalId ? approvalById(sb, approvalId) : Promise.resolve(null))}
          onRequested={(id) => {
            setApprovalId(id);
            try {
              window.localStorage.setItem(APPROVAL_KEY + docId, id);
            } catch {
              // Kept in memory only.
            }
          }}
          onChange={setApproval}
        />
      ) : null}

      <Card>
        <div className="flex flex-col gap-3">
          {item.lot_controlled || lotNo ? (
            <>
              <TextField label={t('floor.receive.lotNo')} value={form.lot_no} onChange={(v) => setForm((f) => ({ ...f, lot_no: v }))} testid="receive-lot" uppercase />
              <div className="grid grid-cols-2 gap-2">
                <TextField label={t('scan.field.production')} type="date" value={form.prod_date} onChange={(v) => setForm((f) => ({ ...f, prod_date: v }))} testid="receive-prod" />
                <TextField label={t('scan.field.expiry')} type="date" value={form.expiry_date} onChange={(v) => setForm((f) => ({ ...f, expiry_date: v }))} testid="receive-expiry" />
              </div>
            </>
          ) : (
            <TextField label={t('floor.receive.lotNoOptional')} value={form.lot_no} onChange={(v) => setForm((f) => ({ ...f, lot_no: v }))} testid="receive-lot" uppercase />
          )}
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <TextField label={t('floor.common.qty')} value={form.qty} onChange={(v) => setForm((f) => ({ ...f, qty: v }))} numeric testid="receive-qty" />
            <ChoiceGrid options={uoms} value={form.uom} onChange={(v) => setForm((f) => ({ ...f, uom: v }))} label={t('floor.common.unit')} columns={3} />
          </div>
          <TextField
            label={needsWeightCheck && weightNeeded ? t('floor.receive.weightFirst') : t('floor.receive.weightOptional')}
            value={form.kg}
            onChange={(v) => setForm((f) => ({ ...f, kg: v }))}
            numeric
            suffix="kg"
            invalid={needsWeightCheck && weightNeeded && !(parseQty(form.kg) ?? 0)}
            testid="receive-kg"
          />
          {form.serial ? (
            <dl>
              <Row label={t('scan.field.serial')} value={form.serial} mono />
            </dl>
          ) : (
            <p className="text-sm font-medium text-muted">{t('floor.receive.serialAuto')}</p>
          )}
        </div>
      </Card>

      <BigButton tone="ghost" onClick={leaveSource} data-testid="receive-back">
        {t('floor.receive.changeDoc')}
      </BigButton>
    </div>
  );
}
