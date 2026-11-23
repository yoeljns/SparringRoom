'use client';

import { useState } from 'react';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from '../DataTable';
import { FormModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, fDate, fDateTime, fNum, T } from '../i18n';
import { JobList } from '../Jobs';
import { useLookups, withLookups, type Lookups } from '../lookups';
import { Badge, Button, Card, Drawer, Empty, Facts, Field, Json, Notice, Select, Stat, StatusBadge, Tabs } from '../ui';

const STATES = ['planned', 'allocated', 'picking', 'loading', 'dispatched', 'cancelled'];
const PLANNERS = ['planner', 'ops_manager', 'owner'];

function WindowBar({ kg, min, max }: { kg: number | null; min: number | null; max: number | null }) {
  if (kg === null || !min || !max) return <span className="text-muted">—</span>;
  const ok = kg >= min && kg <= max;
  return <span className={`tabular-nums font-semibold ${ok ? 'text-ok' : kg > max ? 'text-brand' : 'text-warn'}`}>{fNum(kg, 0)} kg</span>;
}

function ShipmentDetail({ id, lk, onClose, onChanged }: { id: string; lk: Lookups; onClose: () => void; onChanged: () => void }) {
  const { role } = useProfile();
  const mayPlan = !!role && PLANNERS.includes(role);
  const ship = useLoad(() => rows('v_shipment', (q) => q.eq('id', id)).then((r) => r[0] ?? null), [id]);
  const status = useLoad(() => rpc<Row>('rpc_truck_status', { p_shipment: id }), [id]);
  const lines = useLoad(async () => {
    const sl = await rows('shipment_line', (q) => q.eq('shipment_id', id));
    const so = sl.length ? await rows('so_line', (q) => q.in('id', sl.map((x) => x.so_line_id))) : [];
    const byId = new Map(so.map((x) => [x.id, x]));
    return sl.map((x) => ({ ...x, item_id: byId.get(x.so_line_id)?.item_id, line_type: byId.get(x.so_line_id)?.line_type, promised_date: byId.get(x.so_line_id)?.promised_date }));
  }, [id]);
  const truck = useLoad(async () => {
    const s = ship.data;
    if (!s?.truck_load_id) return { lines: [] as Row[], pattern: null as Row | null };
    const [tl, pattern] = await Promise.all([
      rows('truck_load_line', (q) => q.eq('truck_load_id', s.truck_load_id)),
      s.pattern_id ? rows('load_pattern', (q) => q.eq('id', s.pattern_id)).then((r) => r[0] ?? null) : Promise.resolve(null),
    ]);
    return { lines: tl, pattern };
  }, [id, ship.data?.truck_load_id ?? '']);
  const approvals = useLoad(() => rows('approval_request', (q) => q.eq('entity_id', id).order('created_at', { ascending: false })), [id]);
  const act = useAction();
  const [alloc, setAlloc] = useState<Row | null>(null);
  const [mrsl, setMrsl] = useState(false);
  const s = ship.data;
  const st = status.data;
  return (
    <Drawer wide title={s ? `${T('ship.shipment')} ${s.shipment_no}` : T('ship.shipment')} onClose={onClose}>
      {ship.error ? <Notice>{ship.error}</Notice> : null}
      {s ? (
        <Facts items={[
          [T('c.party'), s.party_name], [T('c.state'), <StatusBadge key="s" value={s.state} />], [T('ship.planned'), fDate(s.planned_date)],
          [T('ship.eirsaliye'), s.e_irsaliye_no ? <code key="e" data-testid="eirsaliye">{s.e_irsaliye_no}</code> : <span key="e" className="text-warn">{T('ship.eirsaliyeMissing')}</span>],
          [T('ship.seal'), s.seal_no ?? '—'], [T('ship.vehicle'), `${lk.label('vehicle_type', s.vehicle_type_id)} ${s.vehicle_ref ?? ''}`],
          [T('ship.dispatched'), fDateTime(s.dispatched_at)], [T('ship.invoice'), s.invoice_doc_no ?? '—'],
        ]} />
      ) : null}
      {st ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={T('ship.plannedKg')} value={<WindowBar kg={s?.planned_kg === null || s?.planned_kg === undefined ? null : Number(s.planned_kg)} min={Number(st.min_kg)} max={Number(st.max_kg)} />} hint={T('ship.window', { min: fNum(st.min_kg, 0), max: fNum(st.max_kg, 0) })} />
          <Stat label={T('ship.loadedKg')} value={<WindowBar kg={Number(st.loaded_kg ?? 0)} min={Number(st.min_kg)} max={Number(st.max_kg)} />} hint={st.in_window ? T('ship.inWindow') : T('ship.toMin', { n: fNum(st.to_min_kg, 0) })} />
          <Stat label={T('ship.pallets')} value={`${fNum(st.pallets_loaded, 0)} / ${fNum(st.pallets_total, 0)}`} hint={T('ship.loadedOfTotal')} />
          <Stat label={T('ship.unpicked')} value={fNum(st.unpicked_qty)} tone={Number(st.unpicked_qty) > 0 ? 'warn' : 'ok'} />
        </div>
      ) : status.error ? <Notice>{status.error}</Notice> : null}
      {mayPlan && s && !['dispatched', 'cancelled'].includes(s.state) ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={act.busy} data-testid="allocate-shipment" onClick={() => void act.run(async () => { setAlloc(await rpc<Row>('rpc_allocate', { p_shipment: id })); ship.reload(); status.reload(); onChanged(); })}>{T('ship.allocateThis')}</Button>
          <Button variant="ghost" onClick={() => setMrsl(true)}>{T('ship.mrslRequest')}</Button>
        </div>
      ) : null}
      <Notice>{act.error}</Notice>
      {alloc ? <Notice tone="ok"><span data-testid="alloc-result">{T('ship.allocResult', { hard: alloc.hard_reservations ?? 0, back: alloc.backorders ?? 0, horizon: fDate(alloc.horizon) })}</span></Notice> : null}

      <Card title={T('ship.orderLines')}>
        <DataTable search={false} rows={lines.data} loading={lines.loading} error={lines.error} columns={withLookups([
          { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'line_type', type: 'badge' }, { key: 'qty_base', type: 'num' }, { key: 'shipped_qty', type: 'num' }, { key: 'promised_date', type: 'date' },
        ], lk)} />
      </Card>
      <Card title={T('ship.truckLines')}>
        {truck.data?.pattern ? <p className="mb-2 text-sm">{T('ship.pattern')}: <code>{truck.data.pattern.signature}</code> · {fNum(truck.data.pattern.total_kg, 0)} kg · {T('ship.timesUsed', { n: truck.data.pattern.times_used })}</p> : null}
        <DataTable search={false} rows={truck.data?.lines} loading={truck.loading} error={truck.error} empty={T('ship.noTruckLines')} columns={withLookups([
          { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'lot_id', label: T('stock.lot'), lookup: 'lot' } as Column, { key: 'pallets', type: 'num' }, { key: 'kg', type: 'num' }, { key: 'kg_source', type: 'badge' }, { key: 'actual', type: 'bool' },
        ], lk)} />
      </Card>
      <Card title={T('ship.palletList')}>
        <DataTable search={false} pageSize={15} rows={st?.pallets ?? (status.loading ? undefined : [])} loading={status.loading} rowKey={(r) => String(r.serial)} empty={T('ship.noPallets')} columns={[
          { key: 'serial', type: 'mono' }, { key: 'sku' }, { key: 'lot_no' }, { key: 'kg', type: 'num' }, { key: 'kg_source', type: 'badge' }, { key: 'loaded', type: 'bool' },
        ]} />
      </Card>
      {(approvals.data ?? []).length ? (
        <Card title={T('ship.approvals')}>
          <DataTable search={false} rows={approvals.data} columns={[{ key: 'created_at', type: 'datetime' }, { key: 'type', type: 'badge' }, { key: 'state', type: 'badge' }, { key: 'reason' }, { key: 'payload', type: 'json' }]} />
        </Card>
      ) : null}
      {mrsl ? (
        <FormModal
          title={T('ship.mrslRequest')}
          fields={[{ key: 'mrsl_days', type: 'int', required: true, min: 0, hint: T('ship.mrslHint') }, { key: 'reason', type: 'textarea', required: true }]}
          submitLabel={T('c.sendForApproval')}
          onClose={() => setMrsl(false)}
          onSubmit={async (d) => {
            await rpc('rpc_request_approval', { p_type: 'mrsl_override', p_payload: { shipment_id: id, mrsl_days: d.mrsl_days }, p_reason: d.reason });
            setMrsl(false);
            approvals.reload();
          }}
        />
      ) : null}
    </Drawer>
  );
}

function Shipments() {
  const lk = useLookups(['item', 'lot', 'vehicle_type']);
  const [state, setState] = useState('');
  const [openId, setOpenId] = useUrlParam('id');
  const list = useLoad(() => rows('v_shipment', (q) => (state ? q.eq('state', state) : q).order('planned_date', { ascending: false }).limit(1000)), [state]);
  const vt = (r: Row) => lk.get('vehicle_type', r.vehicle_type_id) ?? lk.list('vehicle_type').find((v) => v.is_default);
  return (
    <>
      <DataTable
        testId="shipment-list"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('ship.empty')}
        onRowClick={(r) => setOpenId(String(r.id))}
        toolbar={<div className="w-44"><Select value={state} onChange={setState} placeholder={T('c.allStates')} options={STATES.map((s) => ({ value: s, label: E(s) }))} /></div>}
        columns={[
          { key: 'shipment_no', type: 'mono' }, { key: 'party_name' }, { key: 'planned_date', type: 'date' }, { key: 'state', type: 'badge' },
          { key: 'planned_kg', type: 'num', render: (r) => <WindowBar kg={r.planned_kg === null ? null : Number(r.planned_kg)} min={Number(vt(r)?.min_kg ?? 0)} max={Number(vt(r)?.max_kg ?? 0)} /> },
          { key: 'window', label: T('ship.windowCol'), render: (r) => (vt(r) ? `${fNum(vt(r)?.min_kg, 0)}–${fNum(vt(r)?.max_kg, 0)}` : '—') },
          { key: 'actual_kg', type: 'num' },
          { key: 'window_ok', render: (r) => (r.window_ok === null ? '—' : r.window_ok ? <Badge tone="ok">{T('ship.inWindow')}</Badge> : <Badge tone="bad">{T('ship.outWindow')}</Badge>) },
          { key: 'pallets_picked', type: 'int' }, { key: 'pallets_loaded', type: 'int' }, { key: 'qty_to_pick', type: 'num' }, { key: 'qty_backorder', type: 'num' },
          { key: 'e_irsaliye_no', render: (r) => r.e_irsaliye_no ?? <span className="text-muted">—</span> },
        ]}
      />
      {openId ? <ShipmentDetail id={openId} lk={lk} onClose={() => setOpenId('')} onChanged={list.reload} /> : null}
    </>
  );
}

function Allocation() {
  const { role } = useProfile();
  const mayPlan = !!role && PLANNERS.includes(role);
  const lk = useLookups(['item', 'party', 'lot', 'location']);
  const act = useAction();
  const [result, setResult] = useState<Row | null>(null);
  const res = useLoad(() => rows('reservation', (q) => q.eq('state', 'active').order('need_date').limit(1000)), []);
  return (
    <div className="space-y-4">
      <Card title={T('ship.allocation')}>
        <p className="mb-3 text-sm text-muted">{T('ship.allocationHelp')}</p>
        {mayPlan ? <Button variant="primary" disabled={act.busy} data-testid="run-allocation" onClick={() => void act.run(async () => { setResult(await rpc<Row>('rpc_allocate', {})); res.reload(); })}>{T('ship.runAllocation')}</Button> : <Notice tone="mute">{T('c.readOnly')}</Notice>}
        <div className="mt-3"><Notice>{act.error}</Notice></div>
        {result ? (
          <div className="mt-3 grid grid-cols-3 gap-3" data-testid="allocation-result">
            <Stat label={T('ship.hardReservations')} value={fNum(result.hard_reservations, 0)} tone="ok" />
            <Stat label={T('ship.backordersMade')} value={fNum(result.backorders, 0)} tone={Number(result.backorders) > 0 ? 'warn' : 'ok'} href="/orders?tab=backorders" />
            <Stat label={T('ship.horizon')} value={fDate(result.horizon)} />
          </div>
        ) : null}
      </Card>
      <Card title={T('ship.reservations')}>
        <DataTable rows={lk.ready ? res.data : undefined} loading={res.loading} error={res.error} empty={T('ship.noReservations')} columns={withLookups([
          { key: 'need_date', type: 'date' }, { key: 'type', type: 'badge' }, { key: 'party_id', label: T('c.party'), lookup: 'party' } as Column, { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column,
          { key: 'lot_id', label: T('stock.lot'), lookup: 'lot' } as Column, { key: 'location_id', label: T('c.location'), lookup: 'location' } as Column, { key: 'qty_base', type: 'num' }, { key: 'original_qty', type: 'num' },
        ], lk)} />
      </Card>
    </div>
  );
}

function PlanResult({ job, lk }: { job: Row; lk: Lookups }) {
  const r: Row = job.result ?? {};
  const trucks: Row[] = r.trucks ?? [];
  const remainder = Object.entries((r.remainder ?? {}) as Row);
  const top: Row | null = r.top_up ?? null;
  const name = (id: string) => lk.label('item', id);
  return (
    <div className="space-y-4" data-testid="plan-result">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={T('ship.nTrucks')} value={fNum(r.n_trucks ?? trucks.length, 0)} />
        <Stat label={T('ship.nPatterns')} value={fNum(r.n_patterns, 0)} />
        <Stat label={T('ship.avgKg')} value={fNum(r.avg_kg, 0)} />
        <Stat label={T('ship.solver')} value={String(r.status ?? '—')} />
      </div>
      <DataTable search={false} rows={trucks} rowKey={(t) => String(t.truck_no)} pageSize={50} empty={T('ship.noTrucks')} columns={[
        { key: 'truck_no', type: 'int' }, { key: 'month', type: 'date' }, { key: 'pattern_id', type: 'mono', render: (t) => String(t.pattern_id).slice(0, 8) },
        { key: 'lines', label: T('ship.truckLines'), render: (t) => (t.lines as Row[]).map((l) => `${name(l.item)} × ${fNum(l.pallets, 0)}`).join(' + ') },
        { key: 'pallets', type: 'int' }, { key: 'kg', type: 'num', render: (t) => <span className={t.window_ok ? 'text-ok' : 'text-brand'}>{fNum(t.kg, 0)}</span> },
      ]} />
      <Card title={T('ship.remainder')}>
        {remainder.length === 0 ? <p className="text-sm text-ok">{T('ship.noRemainder')}</p> : (
          <>
            <ul className="text-sm">{remainder.map(([i, q]) => <li key={i}>{name(i)}: <strong>{fNum(q, 0)}</strong> {T('ship.palletUnit')}</li>)}</ul>
            <h4 className="mb-1 mt-3 text-xs font-bold uppercase text-muted">{T('ship.topUp')}</h4>
            {top ? (
              <p className="text-sm">
                {Object.entries((top.add ?? {}) as Row).map(([i, q]) => `${name(i)} +${fNum(q, 0)}`).join(', ')} · {T('ship.topUpTotal', { p: fNum(top.added_pallets, 0), kg: fNum(top.added_kg, 0) })}
              </p>
            ) : <p className="text-sm text-muted">{T('ship.noTopUp')}</p>}
          </>
        )}
      </Card>
      <details><summary className="cursor-pointer text-sm text-muted">{T('jobs.raw')}</summary><Json value={r} /></details>
    </div>
  );
}

function TruckPlan() {
  const { role } = useProfile();
  const mayPlan = !!role && PLANNERS.includes(role);
  const lk = useLookups(['item', 'party']);
  const orders = useLoad(() => rows('sales_order', (q) => q.in('state', ['confirmed', 'allocated']).order('created_at', { ascending: false }).limit(300)), []);
  const [order, setOrder] = useState('');
  const [version, setVersion] = useState(0);
  const act = useAction();
  const orderNo = (id: unknown) => (orders.data ?? []).find((o) => o.id === id)?.order_no ?? String(id ?? '').slice(0, 8);
  return (
    <div className="space-y-4">
      <Card title={T('ship.planTitle')}>
        <p className="mb-3 text-sm text-muted">{T('ship.planHelp')}</p>
        {mayPlan ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={T('orders.order')} className="w-96">
              <Select name="plan_order" value={order} onChange={setOrder} options={(orders.data ?? []).map((o) => ({ value: String(o.id), label: `${o.order_no} · ${lk.label('party', o.party_id)}${o.schedule ? ` · ${T('ship.hasSchedule')}` : ''}` }))} />
            </Field>
            <Button variant="primary" disabled={!order || act.busy} data-testid="request-plan" onClick={() => void act.run(async () => { await rpc('rpc_enqueue_job', { p_kind: 'plan_trucks', p_payload: { order_id: order } }); setVersion((n) => n + 1); })}>{T('ship.requestPlan')}</Button>
          </div>
        ) : <Notice tone="mute">{T('c.readOnly')}</Notice>}
        <div className="mt-3"><Notice>{act.error}</Notice></div>
      </Card>
      <Card title={T('ship.planJobs')}>
        <JobList kinds={['plan_trucks']} version={version} describe={(j) => `${T('orders.order')} ${orderNo(j.payload?.order_id)}`} renderResult={(j) => <PlanResult job={j} lk={lk} />} />
      </Card>
    </div>
  );
}

function Patterns() {
  const lk = useLookups(['item']);
  const list = useLoad(() => rows('load_pattern', (q) => q.order('times_used', { ascending: false }).limit(500)), []);
  const text = (lines: unknown): string => {
    if (Array.isArray(lines)) return lines.map((l: Row) => `${lk.label('item', l.item_id ?? l.item)} × ${fNum(l.pallets, 0)}`).join(' + ');
    if (lines && typeof lines === 'object') return Object.entries(lines as Row).map(([i, q]) => `${lk.label('item', i)} × ${fNum(q, 0)}`).join(' + ');
    return '—';
  };
  if (list.data && list.data.length === 0) return <Empty>{T('ship.noPatterns')}</Empty>;
  return (
    <DataTable rows={lk.ready ? list.data : undefined} loading={list.loading} error={list.error} columns={[
      { key: 'signature', type: 'mono', render: (r) => <code className="text-xs">{String(r.signature).slice(0, 40)}</code> }, { key: 'lines', label: T('ship.truckLines'), render: (r) => text(r.lines), text: (r) => text(r.lines) },
      { key: 'total_kg', type: 'num' }, { key: 'times_used', type: 'int' }, { key: 'approved', type: 'bool' },
    ]} />
  );
}

export function ShippingScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'shipments', label: T('ship.tabs.shipments'), render: () => <Shipments /> },
        { id: 'allocation', label: T('ship.tabs.allocation'), render: () => <Allocation /> },
        { id: 'plan', label: T('ship.tabs.plan'), render: () => <TruckPlan /> },
        { id: 'patterns', label: T('ship.tabs.patterns'), render: () => <Patterns /> },
      ]}
    />
  );
}
