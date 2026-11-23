'use client';

import { useMemo, useState } from 'react';
import { can } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from '../DataTable';
import { FormModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, fDate, fNum, fPct, T } from '../i18n';
import { MovesTable, QtyLink } from '../Ledger';
import { useLookups, withLookups } from '../lookups';
import { Button, Card, Drawer, Facts, Notice, Select, Stat, StatusBadge, Tabs } from '../ui';

const STATUSES = ['available', 'quarantine', 'blocked_expiry', 'damaged'];
const BANDS = ['green', 'amber', 'red', 'blocked'];
type GroupBy = 'detail' | 'item' | 'lot' | 'location';

function sumBy(list: Row[], keyOf: (r: Row) => string, seed: (r: Row) => Row): Row[] {
  const out = new Map<string, Row>();
  for (const r of list) {
    const k = keyOf(r);
    const cur = out.get(k);
    if (cur) {
      cur.qty_base = Number(cur.qty_base) + Number(r.qty_base ?? 0);
      cur.pallets = Number(cur.pallets) + Number(r.pallets ?? 0);
    } else {
      out.set(k, { ...seed(r), qty_base: Number(r.qty_base ?? 0), pallets: Number(r.pallets ?? 0), _key: k });
    }
  }
  return [...out.values()];
}

function Balances() {
  const { role } = useProfile();
  const mayScrap = can(role, 'scrap.request') || can(role, 'scrap.approve');
  const [groupBy, setGroupBy] = useState<GroupBy>('detail');
  const [status, setStatus] = useState('');
  const [band, setBand] = useUrlParam('band');
  const stock = useLoad(() => rows('v_stock', (q) => q.order('sku').limit(5000)), []);
  const [scrap, setScrap] = useState<Row | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const list = useMemo(() => {
    const base = (stock.data ?? []).filter((r) => (!status || r.stock_status === status) && (!band || r.band === band));
    if (groupBy === 'item') return sumBy(base, (r) => r.item_id, (r) => ({ item_id: r.item_id, sku: r.sku, item_name: r.item_name }));
    if (groupBy === 'lot') return sumBy(base, (r) => `${r.item_id}|${r.lot_id}`, (r) => ({ item_id: r.item_id, sku: r.sku, item_name: r.item_name, lot_id: r.lot_id, lot_no: r.lot_no, expiry_date: r.expiry_date, band: r.band, qc_status: r.qc_status }));
    if (groupBy === 'location') return sumBy(base, (r) => r.location_id, (r) => ({ location_id: r.location_id, location_code: r.location_code, location_type: r.location_type }));
    return base.map((r) => ({ ...r, _key: `${r.item_id}|${r.lot_id}|${r.location_id}|${r.stock_status}|${r.owner_id}` }));
  }, [stock.data, groupBy, status, band]);

  const qty: Column = {
    key: 'qty_base', type: 'num',
    render: (r) => (
      <QtyLink
        value={r.qty_base}
        dims={{
          item_id: r.item_id, lot_id: groupBy === 'detail' || groupBy === 'lot' ? r.lot_id : null, location_id: r.location_id,
          stock_status: groupBy === 'detail' ? r.stock_status : status || null, owner_id: groupBy === 'detail' ? r.owner_id : null,
          title: [r.sku, r.lot_no, r.location_code].filter(Boolean).join(' · '),
        }}
      />
    ),
  };
  const columns: Column[] = {
    detail: [{ key: 'sku' }, { key: 'item_name' }, { key: 'lot_no' }, { key: 'expiry_date', type: 'date' }, { key: 'band', type: 'badge' }, { key: 'location_code' }, { key: 'location_type', type: 'badge' }, { key: 'stock_status', type: 'badge' }, qty, { key: 'pallets', type: 'num' }],
    item: [{ key: 'sku' }, { key: 'item_name' }, qty, { key: 'pallets', type: 'num' }],
    lot: [{ key: 'sku' }, { key: 'lot_no' }, { key: 'expiry_date', type: 'date' }, { key: 'band', type: 'badge' }, { key: 'qc_status', type: 'badge' }, qty, { key: 'pallets', type: 'num' }],
    location: [{ key: 'location_code' }, { key: 'location_type', type: 'badge' }, qty, { key: 'pallets', type: 'num' }],
  }[groupBy] as Column[];

  return (
    <>
      {done ? <div className="mb-3"><Notice tone="ok">{done}</Notice></div> : null}
      <DataTable
        testId="stock-balances"
        rows={stock.data ? list : undefined}
        columns={columns}
        loading={stock.loading}
        error={stock.error}
        rowKey={(r) => String(r._key)}
        toolbar={
          <>
            <div className="w-44"><Select value={groupBy} onChange={(v) => setGroupBy((v || 'detail') as GroupBy)} placeholder={null} options={(['detail', 'item', 'lot', 'location'] as const).map((g) => ({ value: g, label: T(`stock.group.${g}`) }))} /></div>
            <div className="w-44"><Select value={status} onChange={setStatus} placeholder={T('stock.allStatuses')} options={STATUSES.map((s) => ({ value: s, label: E(s) }))} /></div>
            <div className="w-40"><Select value={band} onChange={(v) => setBand(v)} placeholder={T('stock.allBands')} options={BANDS.map((s) => ({ value: s, label: E(s) }))} /></div>
          </>
        }
        actions={groupBy === 'detail' && mayScrap ? (r) => <Button small variant="danger" onClick={() => setScrap(r)}>{T('stock.scrapRequest')}</Button> : undefined}
      />
      {scrap ? (
        <FormModal
          title={T('stock.scrapTitle')}
          fields={[{ key: 'qty', type: 'number', required: true, min: 0.001 }, { key: 'reason', type: 'textarea', required: true }]}
          initial={{ qty: scrap.qty_base }}
          submitLabel={T('stock.scrapSend')}
          onClose={() => setScrap(null)}
          onSubmit={async (d) => {
            await rpc('rpc_request_approval', {
              p_type: 'scrap',
              p_payload: { lines: [{ item_id: scrap.item_id, lot_id: scrap.lot_id, location: scrap.location_code, qty: d.qty, status: scrap.stock_status }] },
              p_reason: d.reason,
            });
            setScrap(null);
            setDone(T('stock.scrapSent'));
          }}
        >
          <p className="text-sm text-muted">{scrap.sku} · {scrap.lot_no ?? '—'} · {scrap.location_code} · {E(scrap.stock_status)}</p>
        </FormModal>
      ) : null}
    </>
  );
}

function LotDetail({ lot, onClose }: { lot: Row; onClose: () => void }) {
  const lk = useLookups(['location']);
  const stock = useLoad(() => rows('v_stock', (q) => q.eq('lot_id', lot.id)), [lot.id]);
  const pallets = useLoad(() => rows('pallet', (q) => q.eq('lot_id', lot.id).order('serial')), [lot.id]);
  const moves = useLoad(() => rows('v_stock_moves', (q) => q.eq('lot_id', lot.id).order('event_at', { ascending: false }).limit(300)), [lot.id]);
  return (
    <Drawer wide title={`${T('stock.lot')} ${lot.lot_no} · ${lot.sku}`} onClose={onClose}>
      <Facts items={[
        [T('c.item'), `${lot.sku} · ${lot.item_name}`],
        [T('stock.prodDate'), fDate(lot.prod_date)],
        [T('stock.expiry'), fDate(lot.expiry_date)],
        [T('stock.band'), <StatusBadge key="b" value={lot.band} />],
        [T('stock.qc'), <StatusBadge key="q" value={lot.qc_status} />],
        [T('stock.palletKg'), fNum(lot.actual_pallet_kg)],
        [T('stock.supplierLot'), lot.supplier_lot ?? '—'],
      ]} />
      <Card title={T('stock.tabs.balances')}>
        <DataTable search={false} rows={stock.data} loading={stock.loading} error={stock.error} rowKey={(r, i) => `${r.location_id}${r.stock_status}${i}`} columns={[
          { key: 'location_code' }, { key: 'stock_status', type: 'badge' },
          { key: 'qty_base', type: 'num', render: (r) => <QtyLink value={r.qty_base} dims={{ item_id: r.item_id, lot_id: r.lot_id, location_id: r.location_id, stock_status: r.stock_status, title: `${r.sku} · ${r.lot_no} · ${r.location_code}` }} /> },
          { key: 'pallets', type: 'num' },
        ]} />
      </Card>
      <Card title={T('stock.tabs.pallets')}>
        <DataTable search={false} rows={pallets.data} loading={pallets.loading} error={pallets.error} pageSize={10} columns={withLookups([
          { key: 'serial', type: 'mono' }, { key: 'qty_base', type: 'num' }, { key: 'location_id', lookup: 'location' } as Column, { key: 'actual_kg', type: 'num' }, { key: 'status', type: 'badge' },
        ], lk)} />
      </Card>
      <Card title={T('ledger.title')}>
        <MovesTable moves={moves.data} loading={moves.loading} error={moves.error} onChanged={() => { moves.reload(); stock.reload(); }} />
      </Card>
    </Drawer>
  );
}

function Lots() {
  const [band, setBand] = useUrlParam('band');
  const lk = useLookups(['item']);
  const lots = useLoad(() => rows('lot', (q) => q.order('expiry_date').limit(5000)), []);
  const stock = useLoad(() => rows('v_stock', (q) => q.limit(5000), 'lot_id,qty_base,pallets'), []);
  const [open, setOpen] = useState<Row | null>(null);
  const list = useMemo(() => {
    const qty = new Map<string, { q: number; p: number }>();
    for (const s of stock.data ?? []) {
      const cur = qty.get(s.lot_id) ?? { q: 0, p: 0 };
      cur.q += Number(s.qty_base ?? 0);
      cur.p += Number(s.pallets ?? 0);
      qty.set(s.lot_id, cur);
    }
    return (lots.data ?? [])
      .filter((l) => !band || l.band === band)
      .map((l): Row => ({ ...l, sku: lk.get('item', l.item_id)?.sku ?? '', item_name: lk.get('item', l.item_id)?.name ?? '', qty_base: qty.get(l.id)?.q ?? 0, pallets: qty.get(l.id)?.p ?? 0 }));
  }, [lots.data, stock.data, lk, band]);
  return (
    <>
      <DataTable
        testId="stock-lots"
        rows={lots.data && lk.ready ? list : undefined}
        loading={lots.loading}
        error={lots.error}
        onRowClick={setOpen}
        toolbar={<div className="w-40"><Select value={band} onChange={(v) => setBand(v)} placeholder={T('stock.allBands')} options={BANDS.map((s) => ({ value: s, label: E(s) }))} /></div>}
        columns={[
          { key: 'sku' }, { key: 'lot_no' }, { key: 'prod_date', type: 'date' }, { key: 'expiry_date', type: 'date' }, { key: 'band', type: 'badge' }, { key: 'qc_status', type: 'badge' },
          { key: 'qty_base', type: 'num', render: (r) => <QtyLink value={r.qty_base} dims={{ item_id: r.item_id, lot_id: r.id, title: `${r.sku} · ${r.lot_no}` }} /> },
          { key: 'pallets', type: 'num' },
        ]}
      />
      {open ? <LotDetail lot={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Pallets() {
  const lk = useLookups(['item', 'lot', 'location']);
  const [status, setStatus] = useState('active');
  const list = useLoad(() => rows('pallet', (q) => (status ? q.eq('status', status) : q).order('serial').limit(3000)), [status]);
  return (
    <DataTable
      rows={lk.ready ? list.data : undefined}
      loading={list.loading}
      error={list.error}
      toolbar={<div className="w-40"><Select value={status} onChange={setStatus} placeholder={T('stock.allStatuses')} options={['active', 'shipped', 'consumed', 'scrapped'].map((s) => ({ value: s, label: E(s) }))} /></div>}
      columns={withLookups([
        { key: 'serial', type: 'mono' }, { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'lot_id', label: T('stock.lot'), lookup: 'lot' } as Column,
        { key: 'location_id', label: T('c.location'), lookup: 'location' } as Column,
        { key: 'qty_base', type: 'num', render: (r) => <QtyLink value={r.qty_base} dims={{ pallet_id: r.id, title: r.serial }} /> },
        { key: 'actual_kg', type: 'num' }, { key: 'status', type: 'badge' }, { key: 'loaded_at', type: 'datetime' },
      ], lk)}
    />
  );
}

function LedgerTab() {
  const [type, setType] = useState('');
  const types = useLoad(() => rows('txn_type_def', (q) => q.order('txn_type'), 'txn_type'), []);
  const moves = useLoad(() => rows('v_stock_moves', (q) => (type ? q.eq('txn_type', type) : q).order('event_at', { ascending: false }).limit(500)), [type]);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('stock.ledgerHelp')}</p>
      <MovesTable
        moves={moves.data}
        loading={moves.loading}
        error={moves.error}
        onChanged={moves.reload}
        toolbar={<div className="w-56"><Select value={type} onChange={setType} placeholder={T('stock.allTypes')} options={(types.data ?? []).map((x) => ({ value: x.txn_type, label: E(x.txn_type) }))} /></div>}
      />
    </>
  );
}

function Lanes() {
  const lanes = useLoad(() => rows('v_lane_utilisation', (q) => q.order('code')), []);
  const allowance = useLoad(() => rpc<Row>('resolve_param', { p_name: 'honeycombing_allowance_pct' }).catch(() => ({ value: null })), []);
  const list = lanes.data ?? [];
  const cap = list.reduce((s, r) => s + Number(r.capacity_pallets ?? 0), 0);
  const used = list.reduce((s, r) => s + Number(r.pallets ?? 0), 0);
  const honey = list.reduce((s, r) => s + Number(r.honeycomb_positions ?? 0), 0);
  const honeyPct = cap > 0 ? (honey / cap) * 100 : null;
  const limit = allowance.data?.value === null || allowance.data?.value === undefined ? null : Number(allowance.data.value);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={T('stock.capacity')} value={fNum(cap, 0)} />
        <Stat label={T('stock.usedPositions')} value={fNum(used, 0)} hint={cap > 0 ? fPct((used / cap) * 100) : undefined} />
        <Stat label={T('stock.honeycomb')} value={fNum(honey, 0)} hint={T('stock.honeycombHint')} />
        <Stat label={T('stock.honeycombPct')} value={fPct(honeyPct)} tone={limit !== null && honeyPct !== null && honeyPct > limit ? 'bad' : 'ok'} hint={limit === null ? undefined : T('stock.allowance', { n: limit })} />
      </div>
      <DataTable
        rows={lanes.data}
        loading={lanes.loading}
        error={lanes.error}
        rowKey={(r) => String(r.location_id)}
        columns={[
          { key: 'code', label: T('c.location') }, { key: 'zone' }, { key: 'depth_class', type: 'int' }, { key: 'sku' }, { key: 'lot_no' },
          { key: 'capacity_pallets', type: 'int' },
          { key: 'pallets', type: 'int', render: (r) => (r.lane_item_id ? <QtyLink digits={0} value={r.pallets} dims={{ location_id: r.location_id, title: r.code }} /> : fNum(r.pallets, 0)) },
          { key: 'fill', label: T('stock.fill'), type: 'pct', text: (r) => (Number(r.capacity_pallets) > 0 ? (Number(r.pallets) / Number(r.capacity_pallets)) * 100 : null), render: (r) => (Number(r.capacity_pallets) > 0 ? fPct((Number(r.pallets) / Number(r.capacity_pallets)) * 100) : '—') },
          { key: 'honeycomb_positions', type: 'int' },
        ]}
      />
    </div>
  );
}

function QcQueue() {
  const list = useLoad(() => rows('v_qc_queue', (q) => q.order('age_hours', { ascending: false })), []);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('stock.qcHelp')}</p>
      <DataTable
        rows={list.data}
        loading={list.loading}
        error={list.error}
        empty={T('stock.qcEmpty')}
        rowKey={(r) => `${r.lot_id}${r.stock_status}`}
        columns={[
          { key: 'sku' }, { key: 'item_name' }, { key: 'lot_no' }, { key: 'expiry_date', type: 'date' }, { key: 'stock_status', type: 'badge' },
          { key: 'qty_base', type: 'num', render: (r) => <QtyLink value={r.qty_base} dims={{ item_id: r.item_id, lot_id: r.lot_id, stock_status: r.stock_status, title: `${r.sku} · ${r.lot_no}` }} /> },
          { key: 'age_hours', type: 'int' }, { key: 'locations' },
        ]}
      />
    </>
  );
}

function Scrap() {
  const lk = useLookups(['user']);
  const list = useLoad(() => rows('approval_request', (q) => q.eq('type', 'scrap').order('created_at', { ascending: false }).limit(200)), []);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('stock.scrapHelp')}</p>
      <DataTable
        rows={list.data}
        loading={list.loading}
        error={list.error}
        empty={T('stock.scrapEmpty')}
        columns={withLookups([
          { key: 'created_at', type: 'datetime' }, { key: 'state', type: 'badge' }, { key: 'reason' },
          { key: 'requested_by', lookup: 'user' } as Column, { key: 'approved_by', lookup: 'user' } as Column, { key: 'decided_at', type: 'datetime' }, { key: 'payload', type: 'json' },
        ], lk)}
      />
    </>
  );
}

function Counts() {
  const { role } = useProfile();
  const mayCreate = role === 'owner' || role === 'ops_manager' || role === 'finance';
  const mayGenerate = can(role, 'task.manage');
  const lk = useLookups(['location', 'user']);
  const [state, setState] = useState('');
  const list = useLoad(() => rows('v_count_task', (q) => (state ? q.eq('state', state) : q).order('created_at', { ascending: false }).limit(1000)), [state]);
  const [adding, setAdding] = useState(false);
  const gen = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      {msg ? <div className="mb-3"><Notice tone="ok">{msg}</Notice></div> : null}
      <Notice>{gen.error}</Notice>
      <DataTable
        testId="count-tasks"
        rows={list.data}
        loading={list.loading}
        error={list.error}
        empty={T('stock.countsEmpty')}
        toolbar={
          <>
            <div className="w-44"><Select value={state} onChange={setState} placeholder={T('c.allStates')} options={['open', 'recount', 'pending_approval', 'closed'].map((s) => ({ value: s, label: E(s) }))} /></div>
            {mayGenerate ? <Button variant="ghost" disabled={gen.busy} onClick={() => void gen.run(async () => { const n = await rpc<number>('rpc_generate_count_tasks'); setMsg(T('stock.countsGenerated', { n })); list.reload(); })}>{T('stock.generateCounts')}</Button> : null}
            {mayCreate ? <Button variant="primary" onClick={() => setAdding(true)}>{T('stock.newCount')}</Button> : null}
          </>
        }
        columns={withLookups([
          { key: 'created_at', type: 'datetime' }, { key: 'location_code' }, { key: 'sku' }, { key: 'lot_no' }, { key: 'trigger', type: 'badge' }, { key: 'state', type: 'badge' },
          { key: 'expected_qty', type: 'num' }, { key: 'counted_qty', type: 'num' }, { key: 'recount_qty', type: 'num' }, { key: 'variance', type: 'num' }, { key: 'variance_eur', type: 'eur' },
          { key: 'within_tolerance', type: 'bool' }, { key: 'assigned_to', lookup: 'user' } as Column, { key: 'counted_by', lookup: 'user' } as Column,
        ], lk)}
      />
      {adding ? (
        <FormModal
          title={T('stock.newCount')}
          lookups={lk}
          fields={[
            { key: 'location', label: T('c.location'), type: 'select', required: true, options: lk.list('location').filter((l) => l.type !== 'virtual').map((l) => ({ value: String(l.code), label: String(l.code) })) },
            { key: 'trigger', type: 'select', required: true, options: ['exception', 'scheduled', 'visit', 'lane_emptied', 'lane_closing'] },
            { key: 'assigned', label: T('stock.assignee'), type: 'lookup', lookup: 'user' },
          ]}
          initial={{ trigger: 'exception' }}
          onClose={() => setAdding(false)}
          onSubmit={async (d) => {
            await rpc('rpc_create_count_task', { p_location: d.location, p_trigger: d.trigger, p_assigned: d.assigned });
            setAdding(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function Ira() {
  const ira = useLoad(() => rows('v_ira_daily', (q) => q.order('day', { ascending: false }).limit(60)), []);
  const scan = useLoad(() => rows('v_scan_compliance', (q) => q.order('day', { ascending: false }).limit(500)), []);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card title={T('stock.iraTitle')}>
        <p className="mb-3 text-sm text-muted">{T('stock.iraHelp')}</p>
        <DataTable search={false} rows={ira.data} loading={ira.loading} error={ira.error} rowKey={(r) => String(r.day)} columns={[{ key: 'day', type: 'date' }, { key: 'counted', type: 'int' }, { key: 'within_tolerance', type: 'int', label: T('stock.withinTol') }, { key: 'ira_pct', type: 'pct' }]} />
      </Card>
      <Card title={T('stock.scanTitle')}>
        <p className="mb-3 text-sm text-muted">{T('stock.scanHelp')}</p>
        <DataTable rows={scan.data} loading={scan.loading} error={scan.error} rowKey={(r) => `${r.day}${r.user_id}`} columns={[{ key: 'day', type: 'date' }, { key: 'full_name' }, { key: 'required', type: 'int' }, { key: 'scanned', type: 'int' }, { key: 'compliance_pct', type: 'pct' }]} />
      </Card>
    </div>
  );
}

export function StockScreen() {
  const { role } = useProfile();
  return (
    <Tabs
      tabs={[
        { id: 'balances', label: T('stock.tabs.balances'), render: () => <Balances /> },
        { id: 'lots', label: T('stock.tabs.lots'), render: () => <Lots /> },
        { id: 'pallets', label: T('stock.tabs.pallets'), render: () => <Pallets /> },
        { id: 'ledger', label: T('stock.tabs.ledger'), render: () => <LedgerTab /> },
        { id: 'lanes', label: T('stock.tabs.lanes'), render: () => <Lanes /> },
        { id: 'qc', label: T('stock.tabs.qc'), render: () => <QcQueue /> },
        { id: 'scrap', label: T('stock.tabs.scrap'), render: () => <Scrap /> },
        { id: 'counts', label: T('stock.tabs.counts'), render: () => <Counts /> },
        { id: 'ira', label: T('stock.tabs.ira'), render: () => <Ira />, hidden: !can(role, 'scanlog.read') },
      ]}
    />
  );
}
