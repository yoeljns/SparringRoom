'use client';

import { useMemo, useState } from 'react';
import { can, parseLogoFile } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import {
  buildOrderLines, ordersFromSalesDocs, toSaveLines, type BundleInfo, type EntryLine, type ImportedOrder, type ItemInfo, type OrderCampaign, type SaveLine,
} from '@/lib/data/office-orders';
import { DataTable, type Column } from '../DataTable';
import { ReasonModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, errText, fDate, fNum, T, todayIso } from '../i18n';
import { QtyLink } from '../Ledger';
import { useLookups, withLookups, type Lookups } from '../lookups';
import { Badge, Button, Card, Drawer, Empty, Facts, Field, Notice, Select, StatusBadge, Tabs, inputCls } from '../ui';

const STATES = ['draft', 'confirmed', 'allocated', 'picking', 'shipped', 'closed', 'cancelled'];

function lineTone(type: string): 'ok' | 'warn' | 'mute' {
  return type === 'free' ? 'ok' : type === 'bundle_component' ? 'warn' : 'mute';
}

/** Items with family code and pack table, plus bundle contents, for the explode functions. */
function useOrderMasters() {
  const lk = useLookups(['item', 'family', 'party', 'vehicle_type', 'bundle', 'market']);
  const packs = useLoad(() => rows('uom_pack', (q) => q.limit(10000), 'item_id,level,qty_base,logo_unit'), []);
  const blines = useLoad(() => rows('bundle_line', (q) => q.limit(5000)), []);
  return useMemo(() => {
    const items = new Map<string, ItemInfo>();
    for (const it of lk.list('item')) {
      items.set(it.id, { id: it.id, sku: it.sku, base_uom: it.base_uom, family_code: lk.get('family', it.family_id)?.code ?? null, attributes: it.attributes ?? {}, packs: {} });
    }
    const unitMap = new Map<string, string>();
    for (const p of packs.data ?? []) {
      const it = items.get(p.item_id);
      if (it) it.packs[p.level] = Number(p.qty_base);
      if (p.logo_unit) unitMap.set(`${p.item_id}|${p.logo_unit}`, p.level);
    }
    const bundles: BundleInfo[] = lk.list('bundle').filter((b) => b.active).map((b) => ({
      id: b.id, item_id: b.item_id, kind: b.kind,
      lines: (blines.data ?? []).filter((l) => l.bundle_id === b.id).map((l) => ({ item_id: l.component_item_id, qty: Number(l.qty) })),
    }));
    return { lk, items, bundles, unitMap, ready: lk.ready && !!packs.data && !!blines.data };
  }, [lk, packs.data, blines.data]);
}

function Basis({ promise }: { promise: Row | null }) {
  if (!promise) return <span className="text-muted">—</span>;
  const basis: Row[] = Array.isArray(promise.basis) ? promise.basis : [];
  return (
    <div className="text-xs">
      <Badge>{T(`orders.method.${promise.method ?? 'atp'}`)}</Badge>
      <ul className="mt-1 space-y-0.5 text-muted">
        {basis.map((b, i) => (
          <li key={i}>
            {E(b.type)}{b.doc_no ? ` ${b.doc_no}` : ''}{b.qty !== undefined ? ` · ${fNum(b.qty)}` : ''}{b.date ? ` · ${fDate(b.date)}` : ''}{b.expected_date ? ` · ${fDate(b.expected_date)}` : ''}
            {b.days !== undefined ? ` · ${T('orders.days', { n: b.days })}` : ''}{b.line ? ` · ${b.line}` : ''}{b.pallets !== undefined ? ` · ${T('orders.pallets', { n: b.pallets })}` : ''}
          </li>
        ))}
        {basis.length === 0 ? <li>{T('orders.basisStock')}</li> : null}
      </ul>
    </div>
  );
}

function OrderDetail({ orderId, lk, onClose, onChanged }: { orderId: string; lk: Lookups; onClose: () => void; onChanged: () => void }) {
  const { role } = useProfile();
  const mayEdit = can(role, 'order.edit');
  const order = useLoad(() => rows('sales_order', (q) => q.eq('id', orderId)).then((r) => r[0] ?? null), [orderId]);
  const lines = useLoad(() => rows('so_line', (q) => q.eq('order_id', orderId).order('line_no')), [orderId]);
  const act = useAction();
  const [confirmed, setConfirmed] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const o = order.data;
  const reload = () => { order.reload(); lines.reload(); onChanged(); };
  return (
    <Drawer wide title={o ? `${T('orders.order')} ${o.order_no}` : T('orders.order')} onClose={onClose}>
      {order.error ? <Notice>{order.error}</Notice> : null}
      {o ? (
        <>
          <Facts items={[
            [T('c.party'), lk.label('party', o.party_id)],
            [T('c.state'), <StatusBadge key="s" value={o.state} />],
            [T('orders.requested'), fDate(o.requested_date)],
            [T('orders.type'), E(o.order_type)],
            [T('orders.tier'), o.priority_tier ?? '—'],
            [T('orders.campaign'), o.campaign_id ? lk.label('campaign', o.campaign_id) : '—'],
            [T('orders.schedule'), o.schedule ? T('orders.scheduleValue', { t: o.schedule.trucks_per_month, m: o.schedule.months }) : '—'],
            [T('orders.logoDoc'), o.logo_doc_no ?? '—'],
            [T('c.note'), o.note ?? '—'],
          ]} />
          {mayEdit ? (
            <div className="flex flex-wrap gap-2">
              {o.state === 'draft' ? (
                <Button variant="primary" disabled={act.busy} data-testid="confirm-order" onClick={() => void act.run(async () => { const res = await rpc<Row>('rpc_confirm_order', { p_order: orderId }); setConfirmed(res); reload(); })}>{T('orders.confirm')}</Button>
              ) : null}
              {!['picking', 'shipped', 'closed', 'cancelled'].includes(o.state) ? <Button variant="danger" onClick={() => setCancelling(true)}>{T('orders.cancel')}</Button> : null}
            </div>
          ) : null}
          <Notice>{act.error}</Notice>
          {confirmed ? (
            <Notice tone="ok">
              <span data-testid="confirm-result">
                {T('orders.confirmed', { tier: confirmed.tier ?? '—' })}{' '}
                {confirmed.shipment_id ? T('orders.shipmentCreated') : o.schedule ? T('orders.truckPlanQueued') : ''}
              </span>
            </Notice>
          ) : null}
        </>
      ) : null}
      <Card title={T('orders.lines')}>
        <DataTable
          testId="order-lines"
          search={false}
          rows={lines.data}
          loading={lines.loading}
          error={lines.error}
          pageSize={100}
          columns={withLookups([
            { key: 'line_no', type: 'int' },
            { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column,
            { key: 'line_type', render: (r) => <span className="inline-flex gap-1"><Badge tone={lineTone(r.line_type)}>{E(r.line_type)}</Badge>{r.is_phantom ? <Badge tone="dark">{T('orders.phantom')}</Badge> : null}</span>, text: (r) => E(r.line_type) },
            { key: 'mechanic_code', render: (r) => (r.mechanic_code ? E(r.mechanic_code) : '—') },
            { key: 'qty_entered', type: 'num', render: (r) => `${fNum(r.qty_entered)} ${E(r.uom)}` },
            { key: 'qty', type: 'num', label: T('orders.qtyBase') },
            { key: 'shipped_qty', type: 'num' },
            { key: 'promised_date', render: (r) => <strong data-testid="promised-date">{fDate(r.promised_date)}</strong>, text: (r) => r.promised_date },
            { key: 'promise_basis', label: T('orders.basis'), render: (r) => (r.is_phantom ? '—' : <Basis promise={r.promise_basis} />) },
            { key: 'backorder', type: 'bool' },
          ], lk)}
        />
      </Card>
      {cancelling ? (
        <ReasonModal title={T('orders.cancel')} confirmLabel={T('orders.cancel')} onClose={() => setCancelling(false)} onSubmit={async (reason) => { await rpc('rpc_cancel_order', { p_order: orderId, p_reason: reason }); setCancelling(false); reload(); }} />
      ) : null}
    </Drawer>
  );
}

function OrderList() {
  const lk = useLookups(['party', 'item', 'campaign']);
  const [state, setState] = useState('');
  const [openId, setOpenId] = useUrlParam('id');
  const list = useLoad(() => rows('sales_order', (q) => (state ? q.eq('state', state) : q).order('created_at', { ascending: false }).limit(1000)), [state]);
  return (
    <>
      <DataTable
        testId="order-list"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('orders.empty')}
        onRowClick={(r) => setOpenId(String(r.id))}
        toolbar={<div className="w-44"><Select value={state} onChange={setState} placeholder={T('c.allStates')} options={STATES.map((s) => ({ value: s, label: E(s) }))} /></div>}
        columns={withLookups([
          { key: 'order_no', type: 'mono' }, { key: 'party_id', label: T('c.party'), lookup: 'party' } as Column, { key: 'requested_date', type: 'date' }, { key: 'state', type: 'badge' },
          { key: 'order_type', type: 'badge' }, { key: 'priority_tier', type: 'int' }, { key: 'campaign_id', label: T('orders.campaign'), lookup: 'campaign' } as Column,
          { key: 'confirmed_at', type: 'datetime' }, { key: 'created_at', type: 'datetime' },
        ], lk)}
      />
      {openId ? <OrderDetail orderId={openId} lk={lk} onClose={() => setOpenId('')} onChanged={list.reload} /> : null}
    </>
  );
}

interface DraftLine {
  item_id: string;
  qty: string;
  uom: string;
}

function PreviewLines({ lines, lk }: { lines: SaveLine[]; lk: Lookups }) {
  return (
    <table className="w-full text-sm" data-testid="order-preview">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th className="py-1 pr-2">{T('c.item')}</th><th className="py-1 pr-2">{T('orders.lineType')}</th><th className="py-1 pr-2 text-right">{T('c.qty')}</th><th className="py-1 pr-2">{T('orders.campaign')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.ref} data-line-type={l.line_type} className={`border-b border-line ${l.parent_ref ? 'bg-surface' : ''}`}>
            <td className={`py-1.5 pr-2 ${l.parent_ref ? 'pl-5' : ''}`}>{l.parent_ref ? '↳ ' : ''}{lk.label('item', l.item_id)}</td>
            <td className="py-1.5 pr-2"><Badge tone={lineTone(l.line_type)}>{E(l.line_type)}</Badge>{l.bundle_id && !l.parent_ref ? <span className="ml-1"><Badge tone="dark">{T('orders.phantom')}</Badge></span> : null}</td>
            <td className="py-1.5 pr-2 text-right tabular-nums">{fNum(l.qty)} {l.uom ? E(l.uom) : T('orders.baseUnit')}</td>
            <td className="py-1.5 pr-2 text-xs text-muted">{l.campaign_code ?? ''}{l.mechanic_code ? ` · ${E(l.mechanic_code)}` : ''}{l.terms?.discount_pct !== undefined ? ` · %${l.terms.discount_pct}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function warningText(w: string): string {
  const [code, ...rest] = w.split(':');
  return `${T(`orders.warn.${code}`)} ${rest.join(' · ')}`;
}

function OrderEntry({ onSaved }: { onSaved: (id: string) => void }) {
  const m = useOrderMasters();
  const [party, setParty] = useState('');
  const [date, setDate] = useState(todayIso(7));
  const [type, setType] = useState('standard');
  const [forwardBuy, setForwardBuy] = useState(false);
  const [note, setNote] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [useSchedule, setUseSchedule] = useState(false);
  const [trucks, setTrucks] = useState('2');
  const [months, setMonths] = useState('3');
  const [start, setStart] = useState(todayIso(14));
  const [lines, setLines] = useState<DraftLine[]>([{ item_id: '', qty: '', uom: '' }]);
  const [errors, setErrors] = useState<string[]>([]);
  const save = useAction();
  const camps = useLoad(
    () => (party && /^\d{4}-\d{2}-\d{2}$/.test(date) ? rpc<OrderCampaign[]>('rpc_campaigns_for_order', { p_party: party, p_date: todayIso() }) : Promise.resolve([] as OrderCampaign[])),
    [party, date],
  );

  const entry: EntryLine[] = lines
    .filter((l) => l.item_id && Number(l.qty.replace(',', '.')) > 0)
    .map((l) => ({ item_id: l.item_id, qty: Number(l.qty.replace(',', '.')), uom: l.uom || m.items.get(l.item_id)?.base_uom || 'piece' }));
  const built = useMemo(() => buildOrderLines(entry, m.items, camps.data ?? [], m.bundles), [JSON.stringify(entry), m.items, camps.data, m.bundles]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const partyOptions = m.lk.options('party', (p) => p.type === 'dealer' || p.type === 'importer');

  const submit = () => {
    const found: string[] = [];
    if (!party) found.push(T('orders.val.party'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.push(T('orders.val.date'));
    if (entry.length === 0) found.push(T('orders.val.lines'));
    if (lines.some((l) => l.item_id && !(Number(l.qty.replace(',', '.')) > 0))) found.push(T('orders.val.qty'));
    if (useSchedule && !(Number(trucks) > 0 && Number(months) > 0 && Number.isInteger(Number(months)))) found.push(T('orders.val.schedule'));
    if (built.warnings.some((w) => w.startsWith('UOM_UNKNOWN'))) found.push(T('orders.val.uom'));
    setErrors(found);
    if (found.length) return;
    void save.run(async () => {
      const res = await rpc<Row>('rpc_save_order', {
        p: {
          party_id: party, requested_date: date, order_type: type, forward_buy: forwardBuy, note: note || null, vehicle_type_id: vehicle || null,
          campaign_id: built.campaign_id, schedule: useSchedule ? { trucks_per_month: Number(trucks), months: Number(months), start } : null,
          lines: toSaveLines(built.lines),
        },
      });
      onSaved(String(res.order_id));
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <Card title={T('orders.entry')} className="xl:col-span-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label={`${T('c.party')} *`} className="md:col-span-2"><Select name="party_id" value={party} onChange={setParty} options={partyOptions} /></Field>
          <Field label={`${T('orders.requested')} *`}><input type="date" name="requested_date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={T('orders.type')}><Select name="order_type" value={type} onChange={setType} placeholder={null} options={['standard', 'export_contract', 'consignment'].map((x) => ({ value: x, label: E(x) }))} /></Field>
          <Field label={T('orders.vehicle')}><Select name="vehicle_type_id" value={vehicle} onChange={setVehicle} options={m.lk.options('vehicle_type')} placeholder={T('orders.defaultVehicle')} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={forwardBuy} onChange={(e) => setForwardBuy(e.target.checked)} className="h-4 w-4" />{T('orders.forwardBuy')}</label>
          <Field label={T('c.note')} className="md:col-span-3"><input name="note" className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>

        <h4 className="mb-2 mt-5 text-xs font-bold uppercase text-muted">{T('orders.lines')}</h4>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const it = m.items.get(l.item_id);
            const uoms = it ? Object.keys(it.packs) : [];
            return (
              <div key={i} className="grid grid-cols-12 items-end gap-2" data-order-line={i}>
                <div className="col-span-6"><Select name={`line.${i}.item`} value={l.item_id} onChange={(v) => setLine(i, { item_id: v, uom: m.items.get(v)?.base_uom ?? '' })} options={m.lk.options('item', (r) => r.active !== false)} placeholder={T('orders.chooseItem')} /></div>
                <div className="col-span-2"><input name={`line.${i}.qty`} inputMode="decimal" placeholder={T('c.qty')} className={inputCls} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></div>
                <div className="col-span-3"><Select name={`line.${i}.uom`} value={l.uom} onChange={(v) => setLine(i, { uom: v })} placeholder={null} options={uoms.map((u) => ({ value: u, label: `${E(u)}${it && it.packs[u] !== 1 ? ` (${fNum(it.packs[u])})` : ''}` }))} /></div>
                <div className="col-span-1"><Button small variant="ghost" aria-label={T('c.remove')} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))}>×</Button></div>
              </div>
            );
          })}
        </div>
        <div className="mt-2"><Button small variant="ghost" data-testid="add-line" onClick={() => setLines((ls) => [...ls, { item_id: '', qty: '', uom: '' }])}>{T('orders.addLine')}</Button></div>

        <h4 className="mb-2 mt-5 text-xs font-bold uppercase text-muted">{T('orders.schedule')}</h4>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="use_schedule" checked={useSchedule} onChange={(e) => setUseSchedule(e.target.checked)} className="h-4 w-4" />{T('orders.useSchedule')}</label>
        {useSchedule ? (
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Field label={T('orders.trucksPerMonth')}><input name="trucks_per_month" inputMode="numeric" className={inputCls} value={trucks} onChange={(e) => setTrucks(e.target.value)} /></Field>
            <Field label={T('orders.months')}><input name="months" inputMode="numeric" className={inputCls} value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
            <Field label={T('orders.scheduleStart')}><input type="date" name="schedule_start" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          </div>
        ) : null}

        <div className="mt-5 space-y-2">
          {errors.length ? <Notice>{errors.join(' ')}</Notice> : null}
          <Notice>{save.error}</Notice>
          <Button variant="primary" disabled={save.busy || !m.ready} onClick={submit} data-testid="save-order">{T('orders.saveDraft')}</Button>
        </div>
      </Card>

      <Card title={T('orders.preview')} className="xl:col-span-2">
        <p className="mb-2 text-sm text-muted">{T('orders.previewHelp')}</p>
        {camps.error ? <Notice>{camps.error}</Notice> : null}
        <div className="mb-3 flex flex-wrap gap-1" data-testid="live-campaigns">
          {(camps.data ?? []).length === 0 ? <span className="text-sm text-muted">{party ? T('orders.noCampaign') : T('orders.pickParty')}</span> : (camps.data ?? []).map((c) => <Badge key={c.id} tone="ok">{c.code} · {c.name}</Badge>)}
        </div>
        {built.lines.length === 0 ? <Empty>{T('orders.noLines')}</Empty> : <PreviewLines lines={built.lines} lk={m.lk} />}
        {built.warnings.length ? <div className="mt-3"><Notice tone="warn">{built.warnings.map(warningText).join(' ')}</Notice></div> : null}
      </Card>
    </div>
  );
}

function OrderImport({ onDone }: { onDone: () => void }) {
  const m = useOrderMasters();
  const [fileName, setFileName] = useState('');
  const [orders, setOrders] = useState<ImportedOrder[] | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const act = useAction();

  const onFile = async (file: File | undefined) => {
    setOrders(null);
    setResults([]);
    setFileErrors([]);
    if (!file) return;
    setFileName(file.name);
    const parsed = parseLogoFile(file.name, await file.text());
    if (parsed.type !== 'sales_docs') return setFileErrors([T('orders.importWrongType')]);
    if (parsed.errors.length) return setFileErrors(parsed.errors.map((e) => `${e.line ? `${T('recon.line')} ${e.line}: ` : ''}${e.code}${e.column ? ` (${e.column})` : ''}`));
    const partyByCari = new Map(m.lk.list('party').filter((p) => p.logo_cari_code).map((p) => [String(p.logo_cari_code), String(p.id)]));
    const itemByCode = new Map(m.lk.list('item').filter((i) => i.logo_item_code).map((i) => [String(i.logo_item_code), String(i.id)]));
    setOrders(ordersFromSalesDocs(parsed.rows, partyByCari, itemByCode, m.unitMap));
  };

  const create = () => void act.run(async () => {
    const out: string[] = [];
    for (const o of orders ?? []) {
      if (o.errors.length || !o.party_id) continue;
      try {
        const camps = o.hasFreeLines ? [] : await rpc<OrderCampaign[]>('rpc_campaigns_for_order', { p_party: o.party_id, p_date: todayIso() });
        const built = buildOrderLines(o.lines, m.items, camps, m.bundles);
        const res = await rpc<Row>('rpc_save_order', { p: { party_id: o.party_id, requested_date: o.doc_date, logo_doc_no: o.doc_no, campaign_id: built.campaign_id, note: T('orders.importNote', { file: fileName }), lines: toSaveLines(built.lines) } });
        out.push(`${o.doc_no}: ${T('orders.importCreated', { n: res.lines })}`);
      } catch (err) {
        out.push(`${o.doc_no}: ${errText(err)}`);
      }
    }
    setResults(out);
    onDone();
  });

  const valid = (orders ?? []).filter((o) => o.errors.length === 0).length;
  return (
    <Card title={T('orders.importTitle')}>
      <p className="mb-3 text-sm text-muted">{T('orders.importHelp')}</p>
      <input type="file" accept=".csv,text/csv" data-testid="order-file" disabled={!m.ready} onChange={(e) => void onFile(e.target.files?.[0])} className="block text-sm" />
      {fileErrors.length ? <div className="mt-3"><Notice>{fileErrors.join(' · ')}</Notice></div> : null}
      {orders ? (
        <div className="mt-4 space-y-3">
          <DataTable
            search={false}
            rows={orders}
            rowKey={(r) => r.doc_no}
            columns={[
              { key: 'doc_no', type: 'mono' }, { key: 'doc_date', type: 'date' }, { key: 'party_id', label: T('c.party'), render: (r) => (r.party_id ? m.lk.label('party', r.party_id) : r.logo_cari_code) },
              { key: 'lines', label: T('orders.lines'), render: (r) => String(r.lines.length) },
              { key: 'errors', label: T('c.errors'), render: (r) => (r.errors.length ? <span className="text-brand">{r.errors.map(warningText).join(' ')}</span> : <Badge tone="ok">{T('c.ok')}</Badge>) },
            ]}
          />
          <Button variant="primary" disabled={act.busy || valid === 0} onClick={create} data-testid="import-orders">{T('orders.importCreate', { n: valid })}</Button>
          <Notice>{act.error}</Notice>
          {results.length ? <Notice tone="ok"><ul>{results.map((r) => <li key={r}>{r}</li>)}</ul></Notice> : null}
        </div>
      ) : null}
    </Card>
  );
}

function Atp() {
  const lk = useLookups(['item', 'party']);
  const [item, setItem] = useUrlParam('item');
  const [party, setParty] = useState('');
  const atp = useLoad(() => (item ? rpc<Row[]>('rpc_atp', { p_item: item, p_party: party || null }) : Promise.resolve(null)), [item, party]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={T('c.item')}><Select name="atp_item" value={item} onChange={(v) => setItem(v)} options={lk.options('item')} /></Field>
        <Field label={T('c.party')} hint={T('orders.atpPartyHint')}><Select name="atp_party" value={party} onChange={setParty} options={lk.options('party', (p) => p.type === 'dealer' || p.type === 'importer')} placeholder={T('orders.atpNoParty')} /></Field>
      </div>
      <p className="text-sm text-muted">{T('orders.atpHelp')}</p>
      {!item ? <Empty>{T('orders.atpPick')}</Empty> : (
        <DataTable
          testId="atp-table"
          search={false}
          pageSize={26}
          rows={atp.data ?? undefined}
          loading={atp.loading}
          error={atp.error}
          rowKey={(r) => String(r.week_start)}
          columns={[
            { key: 'week_start', type: 'date' },
            { key: 'eligible_on_hand', type: 'num', render: (r) => <QtyLink value={r.eligible_on_hand} dims={{ item_id: item, stock_status: 'available', title: lk.label('item', item) }} /> },
            { key: 'receipts_cum', type: 'num' }, { key: 'hard', type: 'num' }, { key: 'soft_cum', type: 'num' },
            { key: 'atp', type: 'num', render: (r) => <strong className={Number(r.atp) < 0 ? 'text-brand' : ''}>{fNum(r.atp)}</strong> },
          ]}
        />
      )}
    </div>
  );
}

function ageBucket(d: number): string {
  return d <= 7 ? '0-7' : d <= 14 ? '8-14' : d <= 30 ? '15-30' : '30+';
}

function Backorders() {
  const [age, setAge] = useUrlParam('age');
  const list = useLoad(() => rows('v_backorder', (q) => q.order('age_days', { ascending: false }).limit(2000)), []);
  const shown = (list.data ?? []).filter((r) => !age || ageBucket(Number(r.age_days)) === age);
  return (
    <DataTable
      testId="backorders"
      rows={list.data ? shown : undefined}
      loading={list.loading}
      error={list.error}
      empty={T('orders.noBackorders')}
      rowKey={(r) => String(r.so_line_id)}
      toolbar={<div className="w-40"><Select value={age} onChange={(v) => setAge(v)} placeholder={T('orders.allAges')} options={['0-7', '8-14', '15-30', '30+'].map((a) => ({ value: a, label: T('orders.ageDays', { a }) }))} /></div>}
      columns={[
        { key: 'order_no', type: 'mono' }, { key: 'party_name' }, { key: 'sku' }, { key: 'qty', type: 'num' }, { key: 'shipped_qty', type: 'num' }, { key: 'open_qty', type: 'num' },
        { key: 'requested_date', type: 'date' }, { key: 'promised_date', type: 'date' }, { key: 'age_days', type: 'int' },
      ]}
    />
  );
}

export function OrdersScreen() {
  const { role } = useProfile();
  const mayEdit = can(role, 'order.edit');
  const [, setTab] = useUrlParam('tab');
  const [version, setVersion] = useState(0);
  return (
    <Tabs
      tabs={[
        { id: 'list', label: T('orders.tabs.list'), render: () => <OrderList key={version} /> },
        { id: 'new', label: T('orders.tabs.new'), hidden: !mayEdit, render: () => <OrderEntry onSaved={(id) => setTab('list', { id })} /> },
        { id: 'import', label: T('orders.tabs.import'), hidden: !mayEdit, render: () => <OrderImport onDone={() => setVersion((n) => n + 1)} /> },
        { id: 'atp', label: T('orders.tabs.atp'), render: () => <Atp /> },
        { id: 'backorders', label: T('orders.tabs.backorders'), render: () => <Backorders /> },
      ]}
    />
  );
}
