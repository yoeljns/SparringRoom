'use client';

import { useState } from 'react';
import { can } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { newUuid, rows, rpc, rpcReturning, type Row } from '@/lib/data/office-db';
import { alertTitle, payloadLine } from '@/lib/notify/render';
import { CrudTable } from '../CrudTable';
import { DataTable, type Column } from '../DataTable';
import { FormModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, fNum, fRatio, T } from '../i18n';
import { QtyLink } from '../Ledger';
import { useLookups, withLookups, type Lookups } from '../lookups';
import { Badge, Button, Card, Drawer, Facts, Notice, StatusBadge, Tabs } from '../ui';

const THRESHOLD = 0.5;

/** Below the confidence threshold the estimate is not shown as a fact (spec 10.3). */
function Confidence({ value }: { value: unknown }) {
  const n = Number(value ?? 0);
  if (n < THRESHOLD) return <Badge tone="warn"><span data-testid="no-dealer-data">{T('dealers.noData')}</span></Badge>;
  return <Badge tone="ok">{fRatio(n)}</Badge>;
}

const estimateColumns = (lk: Lookups, withParty: boolean): Column[] => withLookups([
  ...(withParty ? [{ key: 'party_id', label: T('c.party'), lookup: 'party' } as Column] : []),
  { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column,
  { key: 'qty_est', type: 'num', render: (r) => (Number(r.confidence) < THRESHOLD ? <span className="text-muted">—</span> : fNum(r.qty_est)) },
  { key: 'confidence', render: (r) => <Confidence value={r.confidence} />, text: (r) => Number(r.confidence) },
  { key: 'method', type: 'badge' }, { key: 'weekly_sell_through', type: 'num' },
  { key: 'cover_weeks', type: 'num', render: (r) => (Number(r.confidence) < THRESHOLD ? '—' : fNum(r.cover_weeks, 2)) }, { key: 'as_of', type: 'date' },
], lk);

function DealerDetail({ party, lk, onClose }: { party: Row; lk: Lookups; onClose: () => void }) {
  const stock = useLoad(() => rows('v_stock', (q) => q.eq('dealer_id', party.id).order('sku')), [party.id]);
  const est = useLoad(() => rows('dealer_stock_estimate', (q) => q.eq('party_id', party.id).limit(1000)), [party.id]);
  const obs = useLoad(() => rows('dealer_stock_observation', (q) => q.eq('party_id', party.id).order('observed_at', { ascending: false }).limit(100)), [party.id]);
  return (
    <Drawer wide title={party.name} onClose={onClose}>
      <Facts items={[
        [T('dealers.segment'), party.segment ?? '—'], [T('c.type'), E(party.type)], [T('dealers.market'), lk.label('market', party.market_id)], [T('dealers.consignment'), party.consignment ? T('c.yes') : T('c.no')],
        [T('dealers.cari'), party.logo_cari_code ?? '—'], [T('dealers.city'), party.city ?? '—'], [T('dealers.mrsl'), party.mrsl_profile ?? '—'], [T('dealers.tier'), party.priority_tier ?? '—'],
      ]} />
      <Card title={T('dealers.consStock')}>
        <p className="mb-2 text-sm text-muted">{T('dealers.consHelp')}</p>
        <DataTable search={false} rows={stock.data} loading={stock.loading} error={stock.error} empty={party.consignment ? T('dealers.noConsStock') : T('dealers.notConsignment')} rowKey={(r, i) => `${r.item_id}${r.lot_id}${i}`} columns={[
          { key: 'sku' }, { key: 'item_name' }, { key: 'lot_no' }, { key: 'expiry_date', type: 'date' }, { key: 'band', type: 'badge' }, { key: 'location_code' },
          { key: 'qty_base', type: 'num', render: (r) => <QtyLink value={r.qty_base} dims={{ item_id: r.item_id, lot_id: r.lot_id, location_id: r.location_id, stock_status: r.stock_status, title: `${r.sku} · ${r.location_code}` }} /> },
        ]} />
      </Card>
      <Card title={T('dealers.tabs.estimates')}>
        <DataTable search={false} rows={lk.ready ? est.data : undefined} loading={est.loading} error={est.error} empty={T('dealers.noEstimates')} columns={estimateColumns(lk, false)} />
      </Card>
      <Card title={T('dealers.tabs.observations')}>
        <DataTable search={false} rows={lk.ready ? obs.data : undefined} loading={obs.loading} error={obs.error} empty={T('dealers.noObs')} columns={withLookups([
          { key: 'observed_at', type: 'datetime' }, { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'qty', type: 'num' }, { key: 'source', type: 'badge' }, { key: 'user_id', lookup: 'user' } as Column,
        ], lk)} />
      </Card>
    </Drawer>
  );
}

function DealerList() {
  const lk = useLookups(['party', 'market', 'item', 'user']);
  const [openId, setOpenId] = useUrlParam('id');
  const dealers = lk.list('party').filter((p) => p.type === 'dealer' || p.type === 'importer');
  const open = openId ? lk.get('party', openId) : null;
  return (
    <>
      <DataTable
        testId="dealer-list"
        rows={lk.ready ? dealers : undefined}
        loading={!lk.ready}
        onRowClick={(r) => setOpenId(String(r.id))}
        columns={withLookups([
          { key: 'name' }, { key: 'type', type: 'badge' }, { key: 'segment', render: (r) => (r.segment ? <Badge tone="dark">{r.segment}</Badge> : '—'), text: (r) => r.segment },
          { key: 'market_id', label: T('dealers.market'), lookup: 'market' } as Column, { key: 'city' }, { key: 'consignment', type: 'bool' }, { key: 'short_cycle', type: 'bool' },
          { key: 'priority_tier', type: 'int' }, { key: 'logo_cari_code', type: 'mono' }, { key: 'active', type: 'bool' },
        ], lk)}
      />
      {open ? <DealerDetail party={open} lk={lk} onClose={() => setOpenId('')} /> : null}
    </>
  );
}

function Estimates() {
  const lk = useLookups(['party', 'item']);
  const list = useLoad(() => rows('dealer_stock_estimate', (q) => q.order('as_of', { ascending: false }).limit(5000)), []);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('dealers.estHelp')}</p>
      <DataTable testId="estimates" rows={lk.ready ? list.data : undefined} loading={list.loading} error={list.error} empty={T('dealers.noEstimates')} columns={estimateColumns(lk, true)} />
    </>
  );
}

function Observations() {
  const { role } = useProfile();
  const may = can(role, 'dealer.observe') || role === 'ops_manager';
  const lk = useLookups(['party', 'item', 'user']);
  const list = useLoad(() => rows('dealer_stock_observation', (q) => q.order('observed_at', { ascending: false }).limit(500)), []);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('dealers.obsHelp')}</p>
      <DataTable
        testId="observations"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('dealers.noObs')}
        toolbar={may ? <Button variant="primary" onClick={() => setAdding(true)} data-testid="add-observation">{T('dealers.addObs')}</Button> : undefined}
        columns={withLookups([
          { key: 'observed_at', type: 'datetime' }, { key: 'party_id', label: T('c.party'), lookup: 'party' } as Column, { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column,
          { key: 'qty', type: 'num' }, { key: 'source', type: 'badge' }, { key: 'user_id', lookup: 'user' } as Column,
        ], lk)}
      />
      {adding ? (
        <FormModal
          title={T('dealers.addObs')}
          lookups={lk}
          fields={[
            { key: 'party_id', label: T('c.party'), type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'dealer' || p.type === 'importer', required: true },
            { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true },
            { key: 'qty', type: 'number', required: true, min: 0, hint: T('c.baseUnits') },
            { key: 'source', type: 'select', options: ['count', 'rep_visual', 'self_report'], required: true },
          ]}
          initial={{ source: 'rep_visual' }}
          onClose={() => setAdding(false)}
          onSubmit={async (d) => {
            await rpcReturning('rpc_floor', { p_cmd: 'dealer_observation', p_args: { client_uuid: newUuid(), party_id: d.party_id, item_id: d.item_id, qty: d.qty, source: d.source, scan_method: 'manual' } });
            setAdding(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function Warnings() {
  const lk = useLookups(['party', 'item']);
  const alerts = useLoad(() => rows('alert', (q) => q.eq('rule', 'channel_loading').order('created_at', { ascending: false }).limit(200)), []);
  const limit = useLoad(() => rpc<Row>('resolve_param', { p_name: 'channel_cover_weeks' }).then((r) => Number(r?.value ?? 12)).catch(() => 12), []);
  const est = useLoad(() => rows('dealer_stock_estimate', (q) => q.gte('confidence', THRESHOLD).limit(5000)), []);
  const over = (est.data ?? []).filter((e) => Number(e.cover_weeks) > (limit.data ?? 12));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{T('dealers.warnHelp', { n: limit.data ?? 12 })}</p>
      <Card title={T('dealers.overCover')}>
        <DataTable rows={lk.ready && est.data ? over : undefined} loading={est.loading} error={est.error} empty={T('dealers.noWarnings')} columns={estimateColumns(lk, true)} />
      </Card>
      <Card title={T('dealers.warnAlerts')}>
        <DataTable search={false} rows={alerts.data} loading={alerts.loading} error={alerts.error} empty={T('dealers.noWarnings')} columns={[
          { key: 'created_at', type: 'datetime' }, { key: 'rule', render: (r) => alertTitle(r.rule) }, { key: 'payload', label: T('alerts.detail'), render: (r) => payloadLine(r.payload) }, { key: 'acked_at', type: 'datetime' },
        ]} />
      </Card>
    </div>
  );
}

function Vmi() {
  const { role } = useProfile();
  const may = !!role && ['sales_rep', 'planner', 'ops_manager', 'owner'].includes(role);
  const lk = useLookups(['party', 'item']);
  const list = useLoad(() => rows('vmi_proposal', (q) => q.order('created_at', { ascending: false }).limit(300)), []);
  const act = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const linesText = (r: Row) => ((r.lines ?? []) as Row[]).map((l) => `${lk.label('item', l.item_id)} × ${fNum(l.qty)}`).join(', ');
  const decide = (r: Row, approve: boolean) => void act.run(async () => {
    const res = await rpc<Row>('rpc_vmi_decide', { p_id: r.id, p_approve: approve });
    setMsg(approve ? T('dealers.vmiApproved', { id: String(res.order_id ?? '').slice(0, 8) }) : T('dealers.vmiRejected'));
    list.reload();
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{T('dealers.vmiHelp')}</p>
      <Notice>{act.error}</Notice>
      {msg ? <Notice tone="ok">{msg}</Notice> : null}
      <DataTable
        testId="vmi-list"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('dealers.noVmi')}
        columns={withLookups([
          { key: 'created_at', type: 'datetime' }, { key: 'party_id', label: T('c.party'), lookup: 'party' } as Column, { key: 'lines', label: T('orders.lines'), render: linesText, text: linesText },
          { key: 'state', render: (r) => <StatusBadge value={r.state} />, text: (r) => r.state }, { key: 'decided_at', type: 'datetime' },
        ], lk)}
        actions={may ? (r) => (r.state === 'proposed' ? (
          <>
            <Button small variant="primary" disabled={act.busy} data-testid="vmi-approve" onClick={() => decide(r, true)}>{T('appr.approve')}</Button>
            <Button small variant="danger" disabled={act.busy} onClick={() => decide(r, false)}>{T('appr.reject')}</Button>
          </>
        ) : null) : undefined}
      />
      <Card title={T('dealers.vmiParams')}>
        <CrudTable config={{
          table: 'vmi_param', lookups: ['party', 'item'],
          columns: [{ key: 'party_id', label: T('c.party'), lookup: 'party' }, { key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'min_qty', type: 'num' }, { key: 'max_qty', type: 'num' }, { key: 'active', type: 'bool' }],
          fields: [
            { key: 'party_id', label: T('c.party'), type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'dealer', required: true }, { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true },
            { key: 'min_qty', type: 'number', required: true, min: 0 }, { key: 'max_qty', type: 'number', required: true, min: 0 }, { key: 'active', type: 'bool' },
          ],
          defaults: { active: true },
        }} />
      </Card>
    </div>
  );
}

function Reps() {
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('dealers.repsHelp')}</p>
      <CrudTable config={{
        table: 'rep_dealer', roles: ['owner', 'ops_manager'], lookups: ['user', 'party'], deletable: true, addLabel: T('dealers.assign'),
        columns: [{ key: 'user_id', label: T('dealers.rep'), lookup: 'user' }, { key: 'party_id', label: T('c.party'), lookup: 'party' }, { key: 'created_at', type: 'datetime' }],
        fields: [
          { key: 'user_id', label: T('dealers.rep'), type: 'lookup', lookup: 'user', lookupFilter: (u) => u.role === 'sales_rep', required: true },
          { key: 'party_id', label: T('c.party'), type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'dealer' || p.type === 'importer', required: true },
        ],
      }} />
    </>
  );
}

export function DealersScreen() {
  const { role } = useProfile();
  return (
    <Tabs
      tabs={[
        { id: 'dealers', label: T('dealers.tabs.dealers'), render: () => <DealerList /> },
        { id: 'estimates', label: T('dealers.tabs.estimates'), render: () => <Estimates /> },
        { id: 'observations', label: T('dealers.tabs.observations'), render: () => <Observations /> },
        { id: 'warnings', label: T('dealers.tabs.warnings'), render: () => <Warnings /> },
        { id: 'vmi', label: T('dealers.tabs.vmi'), render: () => <Vmi /> },
        { id: 'reps', label: T('dealers.tabs.reps'), render: () => <Reps />, hidden: role === 'sales_rep' },
      ]}
    />
  );
}
