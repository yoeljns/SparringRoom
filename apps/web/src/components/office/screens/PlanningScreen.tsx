'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { can } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import { CrudTable } from '../CrudTable';
import { DataTable, type Column } from '../DataTable';
import { FormModal, ReasonModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, fDate, fNum, fRatio, T } from '../i18n';
import { JobList } from '../Jobs';
import { useLookups, withLookups, type Lookups } from '../lookups';
import { Badge, Button, Card, Empty, Field, Json, Notice, Select, Stat, StatusBadge, Tabs } from '../ui';

const PLAN_ROLES = ['planner', 'ops_manager', 'owner'];
const SCOPES = ['global', 'site', 'family', 'class', 'item', 'vehicle_type', 'market', 'market_segment', 'party', 'party_item'];
const NIGHTLY = [
  'build_demand_history', 'measure_lead_times', 'classify', 'forecast', 'compute_policy', 'suggest', 'expiry_bands', 'slow_stock', 'campaign_tick', 'dealer_estimate',
  'campaign_review', 'uplift_model', 'ddmrp_shadow', 'vmi_proposals', 'load_planner', 'count_tasks', 'reconciliation', 'rebuild_check', 'nightly_checks',
];

function useCurrentRun() {
  return useLoad(() => rows('forecast_run', (q) => q.eq('is_current', true).limit(1)).then((r) => r[0] ?? null), []);
}

function Cycle() {
  const steps: { week: number; links: [string, string][] }[] = [
    { week: 1, links: [['/reconciliation?tab=inbound', 'cycle.l.import'], ['/reconciliation?tab=diffs', 'cycle.l.recon'], ['/planning?tab=forecast', 'cycle.l.forecast'], ['/planning?tab=accuracy', 'cycle.l.accuracy']] },
    { week: 2, links: [['/campaigns?tab=list', 'cycle.l.calendar'], ['/planning?tab=forecast', 'cycle.l.overrides']] },
    { week: 3, links: [['/planning?tab=suggestions', 'cycle.l.suggestions'], ['/shipping?tab=plan', 'cycle.l.trucks'], ['/planning?tab=slow', 'cycle.l.slow']] },
    { week: 4, links: [['/planning?tab=projection', 'cycle.l.exceptions'], ['/approvals', 'cycle.l.approvals'], ['/planning?tab=plans', 'cycle.l.publish']] },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="monthly-cycle">
      {steps.map((s) => (
        <Card key={s.week} title={T('cycle.week', { n: s.week })}>
          <p className="text-base font-bold">{T(`cycle.step${s.week}`)}</p>
          <p className="mb-3 mt-1 text-sm text-muted">{T(`cycle.out${s.week}`)}</p>
          <ul className="space-y-1 text-sm">
            {s.links.map(([href, key]) => <li key={key}><Link href={href} className="font-semibold text-brand underline">{T(key)}</Link></li>)}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function Classification() {
  const lk = useLookups(['item']);
  const list = useLoad(() => rows('v_item_class', (q) => q.limit(5000)), []);
  return (
    <DataTable
      rows={lk.ready ? list.data : undefined}
      loading={list.loading}
      error={list.error}
      empty={T('plan.noClass')}
      columns={withLookups([
        { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'abc', render: (r) => <Badge tone="dark">{r.abc}{r.xyz}</Badge>, text: (r) => `${r.abc}${r.xyz}` }, { key: 'pattern', type: 'badge' },
        { key: 'adi', type: 'num' }, { key: 'cv2', type: 'num' }, { key: 'cv_monthly', type: 'num' }, { key: 'criticality', type: 'bool' }, { key: 'service_class' },
        { key: 'service_level', type: 'ratio' }, { key: 'consumption_value_eur', type: 'eur' }, { key: 'lifecycle_flag', type: 'badge' },
      ], lk)}
    />
  );
}

function Forecast() {
  const { role } = useProfile();
  const mayOverride = can(role, 'forecast.override');
  const lk = useLookups(['item', 'family', 'user']);
  const run = useCurrentRun();
  const [level, setLevel] = useState<'sku' | 'family'>('sku');
  const [item, setItem] = useUrlParam('item');
  const [family, setFamily] = useState('');
  const node = level === 'sku' ? item : family;
  const fc = useLoad(async () => {
    if (!run.data || !node) return null;
    return rows('forecast', (q) => {
      q = q.eq('run_id', run.data!.id).eq('level', level);
      q = level === 'sku' ? q.eq('item_id', node).eq('bucket', 'week') : q.eq('node', node).eq('bucket', 'month');
      return q.order('period').limit(level === 'sku' ? 26 : 18);
    });
  }, [run.data?.id ?? '', level, node]);
  const overrides = useLoad(() => (level === 'sku' && item ? rows('forecast_override', (q) => q.eq('item_id', item).order('period', { ascending: false }).limit(100)) : Promise.resolve([] as Row[])), [level, item]);
  const [target, setTarget] = useState<Row | 'new' | null>(null);
  const [withdraw, setWithdraw] = useState<Row | null>(null);
  const reload = () => { fc.reload(); overrides.reload(); };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Field label={T('plan.level')}><Select value={level} onChange={(v) => setLevel((v || 'sku') as 'sku' | 'family')} placeholder={null} options={[{ value: 'sku', label: T('plan.levelSku') }, { value: 'family', label: T('plan.levelFamily') }]} /></Field>
        {level === 'sku' ? (
          <Field label={T('c.item')} className="md:col-span-2"><Select name="fc_item" value={item} onChange={(v) => setItem(v)} options={lk.options('item')} /></Field>
        ) : (
          <Field label={T('plan.family')} className="md:col-span-2"><Select value={family} onChange={setFamily} options={lk.list('family').map((f) => ({ value: String(f.code), label: `${f.code} · ${f.name}` }))} /></Field>
        )}
        <div className="self-end text-xs text-muted">{run.data ? T('plan.runInfo', { at: fDate(run.data.run_at), v: run.data.param_version ?? '—' }) : T('plan.noRun')}</div>
      </div>
      {!node ? <Empty>{T('plan.pickNode')}</Empty> : (
        <DataTable
          testId="forecast-table"
          search={false}
          pageSize={26}
          rows={fc.data ?? (fc.loading ? undefined : [])}
          loading={fc.loading}
          error={fc.error ?? run.error}
          empty={T('plan.noForecast')}
          toolbar={mayOverride && level === 'sku' ? <Button variant="primary" onClick={() => setTarget('new')} data-testid="new-override">{T('plan.newOverride')}</Button> : undefined}
          columns={[
            { key: 'period', type: 'date' }, { key: 'base', type: 'num' }, { key: 'campaign_delta', type: 'num' }, { key: 'override_delta', type: 'num' },
            { key: 'final', type: 'num', render: (r) => <strong>{fNum(r.final)}</strong> }, { key: 'method', type: 'badge' },
          ]}
          actions={mayOverride && level === 'sku' ? (r) => <Button small variant="ghost" onClick={() => setTarget(r)}>{T('plan.override')}</Button> : undefined}
        />
      )}
      {level === 'sku' && item ? (
        <Card title={T('plan.overrides')}>
          <DataTable
            testId="override-list"
            search={false}
            rows={overrides.data}
            loading={overrides.loading}
            error={overrides.error}
            empty={T('plan.noOverrides')}
            columns={withLookups([
              { key: 'period', type: 'date' }, { key: 'bucket', type: 'badge' }, { key: 'delta', type: 'num' }, { key: 'reason' }, { key: 'source', type: 'badge' }, { key: 'state', type: 'badge' },
              { key: 'fva', type: 'num' }, { key: 'user_id', lookup: 'user' } as Column, { key: 'created_at', type: 'datetime' },
            ], lk)}
            actions={mayOverride ? (r) => (r.state === 'active' ? <Button small variant="danger" onClick={() => setWithdraw(r)}>{T('plan.withdraw')}</Button> : null) : undefined}
          />
        </Card>
      ) : null}
      {target ? (
        <FormModal
          title={T('plan.overrideTitle')}
          fields={[
            { key: 'period', type: 'date', required: true, hint: T('plan.periodHint') }, { key: 'delta', type: 'number', required: true, hint: T('plan.deltaHint') },
            { key: 'reason', type: 'textarea', required: true },
          ]}
          initial={target === 'new' ? {} : { period: target.period }}
          onClose={() => setTarget(null)}
          onSubmit={async (d) => {
            await rpc('rpc_forecast_override', { p: { item_id: item, period: d.period, delta: d.delta, reason: d.reason, bucket: 'week', level: 'sku' } });
            setTarget(null);
            reload();
          }}
        />
      ) : null}
      {withdraw ? (
        <ReasonModal title={T('plan.withdraw')} onClose={() => setWithdraw(null)} onSubmit={async (reason) => { await rpc('rpc_forecast_override', { p: { withdraw_id: withdraw.id, reason } }); setWithdraw(null); reload(); }} />
      ) : null}
    </div>
  );
}

function Accuracy() {
  const lk = useLookups(['item', 'family']);
  const run = useCurrentRun();
  const list = useLoad(() => (run.data ? rows('forecast_accuracy', (q) => q.eq('run_id', run.data!.id).limit(5000)) : Promise.resolve(run.loading ? undefined : ([] as Row[]))), [run.data?.id ?? '', run.loading]);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('plan.accuracyHelp')}</p>
      <DataTable
        rows={lk.ready ? list.data : undefined}
        loading={list.loading || run.loading}
        error={list.error}
        empty={T('plan.noAccuracy')}
        columns={withLookups([
          { key: 'family_id', label: T('plan.family'), lookup: 'family' } as Column, { key: 'item_id', label: T('c.item'), render: (r) => (r.item_id ? lk.label('item', r.item_id) : T('plan.familyTotal')) },
          { key: 'lag_weeks', type: 'int' }, { key: 'n', type: 'int' }, { key: 'wape', type: 'ratio' },
          { key: 'bias', type: 'ratio', render: (r) => <span className={Math.abs(Number(r.bias)) > 0.1 ? 'font-bold text-brand' : ''}>{fRatio(r.bias)}</span> },
          { key: 'mase', type: 'num' }, { key: 'wape_naive', type: 'ratio' }, { key: 'wape_stat', type: 'ratio' }, { key: 'wape_final', type: 'ratio' },
          { key: 'fva_stat', type: 'ratio' }, { key: 'fva_final', type: 'ratio', render: (r) => <span className={Number(r.fva_final) < 0 ? 'font-bold text-brand' : ''}>{fRatio(r.fva_final)}</span> },
        ], lk)}
      />
    </>
  );
}

function LeadTimes() {
  const lk = useLookups(['supplier_lane', 'party', 'family', 'item']);
  const stats = useLoad(() => rows('lead_time_stat', (q) => q.order('as_of', { ascending: false }).limit(2000)), []);
  const list = useMemo(() => {
    const seen = new Set<string>();
    const latest = (stats.data ?? []).filter((s) => {
      const k = `${s.supplier_lane_id}|${s.production_line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const withStat = new Set(latest.map((s) => s.supplier_lane_id).filter(Boolean));
    const out: Row[] = latest.map((s) => {
      const lane = lk.get('supplier_lane', s.supplier_lane_id);
      return { ...s, lane, quoted: lane?.quoted_lt_days ?? null };
    });
    for (const lane of lk.list('supplier_lane')) {
      if (!withStat.has(lane.id)) out.push({ id: `lane-${lane.id}`, supplier_lane_id: lane.id, production_line: lane.production_line, lane, quoted: lane.quoted_lt_days, source: 'quoted', n: 0 });
    }
    return out;
  }, [stats.data, lk]);
  const laneName = (r: Row) => (r.lane ? `${r.lane.supplier_id ? lk.label('party', r.lane.supplier_id) : (r.lane.production_line ?? '')} · ${r.lane.item_id ? lk.label('item', r.lane.item_id) : lk.label('family', r.lane.item_family_id)} · ${E(r.lane.mode)}` : (r.production_line ?? '—'));
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('plan.leadHelp')}</p>
      <DataTable
        rows={lk.ready && stats.data ? list : undefined}
        loading={stats.loading}
        error={stats.error}
        columns={[
          { key: 'lane', label: T('plan.lane'), render: laneName, text: laneName }, { key: 'quoted', label: T('plan.quoted'), type: 'num' }, { key: 'n', type: 'int' },
          { key: 'mean_days', type: 'num', render: (r) => (r.mean_days === undefined ? '—' : <span className={r.quoted && Math.abs(Number(r.mean_days) - Number(r.quoted)) / Number(r.quoted) > 0.15 ? 'font-bold text-brand' : ''}>{fNum(r.mean_days, 2)}</span>) },
          { key: 'sd_days', type: 'num' }, { key: 'p90_days', type: 'num' }, { key: 'source', type: 'badge' }, { key: 'as_of', type: 'date' },
        ]}
      />
    </>
  );
}

function scopeLabel(r: Row, lk: Lookups): string {
  if (r.scope_type === 'global') return E('global');
  const id = String(r.scope_id);
  const name = r.scope_type === 'item' ? lk.label('item', id) : r.scope_type === 'party' ? lk.label('party', id) : r.scope_type === 'market' ? lk.label('market', id)
    : r.scope_type === 'family' ? lk.label('family', id) : r.scope_type === 'vehicle_type' ? lk.label('vehicle_type', id) : id;
  return `${E(r.scope_type)}: ${name}`;
}

function Params() {
  const { role } = useProfile();
  const mayPropose = can(role, 'params.propose');
  const lk = useLookups(['item', 'party', 'market', 'family', 'vehicle_type', 'user']);
  const [state, setState] = useState('published');
  const params = useLoad(() => rows('planning_param', (q) => (state ? q.eq('state', state) : q).order('param').limit(5000)), [state]);
  const pending = useLoad(() => rows('approval_request', (q) => q.eq('type', 'param_publish').eq('state', 'pending').order('created_at', { ascending: false })), []);
  const names = useLoad(() => rows('planning_param', (q) => q.limit(5000), 'param'), []);
  const [proposing, setProposing] = useState<Row | 'new' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const paramNames = [...new Set((names.data ?? []).map((r) => String(r.param)))].sort();
  return (
    <div className="space-y-4">
      {msg ? <Notice tone="ok"><span data-testid="param-msg">{msg}</span></Notice> : null}
      {(pending.data ?? []).length ? (
        <Card title={T('plan.pendingParams')}>
          <ul className="space-y-1 text-sm" data-testid="pending-params">
            {(pending.data ?? []).map((a) => (
              <li key={a.id}>
                <Badge tone="warn">{E('pending')}</Badge>{' '}
                {((a.payload?.rows ?? []) as Row[]).map((r) => `${r.param} → ${JSON.stringify(r.value)}`).join(', ')} · {lk.label('user', a.requested_by)} · <Link href="/approvals" className="text-brand underline">{T('plan.toApprovals')}</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <DataTable
        testId="param-table"
        rows={lk.ready ? params.data : undefined}
        loading={params.loading}
        error={params.error}
        pageSize={50}
        toolbar={
          <>
            <div className="w-44"><Select value={state} onChange={setState} placeholder={T('c.allStates')} options={['published', 'draft', 'superseded', 'rejected'].map((s) => ({ value: s, label: E(s) }))} /></div>
            {mayPropose ? <Button variant="primary" onClick={() => setProposing('new')} data-testid="propose-param">{T('plan.propose')}</Button> : null}
          </>
        }
        columns={[
          { key: 'param', type: 'mono' }, { key: 'scope', label: T('plan.scope'), render: (r) => scopeLabel(r, lk), text: (r) => scopeLabel(r, lk) },
          { key: 'value', render: (r) => <strong data-param={r.param} data-scope={r.scope_type}>{JSON.stringify(r.value)}</strong>, text: (r) => JSON.stringify(r.value) },
          { key: 'valid_from', type: 'date' }, { key: 'valid_to', type: 'date' }, { key: 'version', type: 'int' }, { key: 'state', type: 'badge' }, { key: 'note' },
        ]}
        actions={mayPropose ? (r) => (r.state === 'published' ? <Button small variant="ghost" onClick={() => setProposing(r)}>{T('plan.change')}</Button> : null) : undefined}
      />
      {proposing ? (
        <FormModal
          title={T('plan.proposeTitle')}
          fields={[
            { key: 'param', type: 'select', required: true, options: paramNames.map((p) => ({ value: p, label: p })) },
            { key: 'scope_type', type: 'select', required: true, options: SCOPES },
            { key: 'scope_id', hint: T('plan.scopeIdHint'), show: (v) => v.scope_type !== 'global' },
            { key: 'value', required: true, hint: T('plan.valueHint') },
            { key: 'valid_from', type: 'date', required: true }, { key: 'note', label: T('c.reason'), type: 'textarea', required: true },
          ]}
          initial={proposing === 'new' ? { scope_type: 'global', valid_from: new Date().toISOString().slice(0, 10) } : { param: proposing.param, scope_type: proposing.scope_type, scope_id: proposing.scope_id, value: JSON.stringify(proposing.value), valid_from: new Date().toISOString().slice(0, 10) }}
          submitLabel={role === 'owner' ? T('plan.publishNow') : T('c.sendForApproval')}
          onClose={() => setProposing(null)}
          onSubmit={async (d) => {
            let value: unknown = d.value;
            try { value = JSON.parse(String(d.value)); } catch { /* plain text value */ }
            const res = await rpc<Row>('rpc_param_propose', { p_rows: [{ scope_type: d.scope_type, scope_id: d.scope_type === 'global' ? '*' : (d.scope_id ?? '*'), param: d.param, value, valid_from: d.valid_from }], p_note: d.note });
            setMsg(res.published ? T('plan.published', { v: res.param_version }) : T('plan.proposed'));
            setProposing(null);
            params.reload();
            pending.reload();
          }}
        >
          <Notice tone="mute">{T('plan.proposeHelp')}</Notice>
        </FormModal>
      ) : null}
    </div>
  );
}

/** The one line under a suggested quantity: the inputs it was computed from (spec 8.6). */
function inputsLine(s: Row): string {
  const i: Row = s.inputs ?? {};
  const parts: string[] = [];
  const add = (label: string, v: unknown, fmt: (x: unknown) => string = (x) => fNum(x, 2)) => { if (v !== null && v !== undefined && v !== '') parts.push(`${label} ${fmt(v)}`); };
  add(T('sug.forecastRun'), i.forecast_run_id ?? i.forecast_run, (x) => String(x).slice(0, 8));
  add(T('sug.leadStat'), i.lead_time_stat_id ?? i.lead_time_source, (x) => String(x).slice(0, 8));
  add(T('sug.L'), i.L, (x) => `${fNum(x, 2)} ${T('sug.weeks')}`);
  add(T('sug.sdL'), i.sd_L);
  add(T('sug.service'), i.service_level, fRatio);
  add(T('sug.paramVersion'), i.param_version, String);
  add(T('sug.d'), i.d);
  add(T('sug.ss'), i.safety_stock);
  add(T('sug.rop'), i.rop ?? i.order_up_to);
  add(T('sug.projected'), i.projected_available);
  return parts.join(' · ') || T('sug.noInputs');
}

function Suggestions() {
  const { role } = useProfile();
  const may = !!role && PLAN_ROLES.includes(role);
  const [state, setState] = useState('proposed');
  const list = useLoad(() => rows('v_suggestion', (q) => (state ? q.eq('state', state) : q).order('release_date').limit(2000)), [state]);
  const act = useAction();
  const [editing, setEditing] = useState<Row | null>(null);
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const groups = useMemo(() => {
    const out = new Map<string, Row[]>();
    for (const s of list.data ?? []) {
      const k = s.type === 'production' ? `__prod` : String(s.supplier_id ?? '__none');
      out.set(k, [...(out.get(k) ?? []), s]);
    }
    return [...out.entries()];
  }, [list.data]);
  const decide = (id: string, action: string, qty: number | null = null, reason: string | null = null) => rpc('rpc_suggestion_decide', { p_id: id, p_action: action, p_qty: qty, p_reason: reason }).then(() => list.reload());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-44"><Select value={state} onChange={setState} placeholder={T('c.allStates')} options={['proposed', 'accepted', 'edited', 'rejected', 'superseded'].map((s) => ({ value: s, label: E(s) }))} /></div>
        <p className="text-sm text-muted">{T('sug.help')}</p>
      </div>
      <Notice>{list.error ?? act.error}</Notice>
      {list.data && groups.length === 0 ? <Empty>{T('sug.empty')}</Empty> : null}
      {groups.map(([key, items]) => {
        const first = items[0];
        const total = items.reduce((s, x) => s + Number(x.qty), 0);
        const moq = first.moq === null ? null : Number(first.moq);
        const breaks: Row[] = Array.isArray(first.price_breaks) ? first.price_breaks : [];
        const reached = [...breaks].sort((a, b) => Number(b.min_qty) - Number(a.min_qty)).find((b) => total >= Number(b.min_qty));
        const next = [...breaks].sort((a, b) => Number(a.min_qty) - Number(b.min_qty)).find((b) => total < Number(b.min_qty));
        return (
          <Card key={key} title={key === '__prod' ? T('sug.production') : (first.supplier_name ?? T('sug.noSupplier'))}>
            {key !== '__prod' ? (
              <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="supplier-group">
                <Stat label={T('sug.groupTotal')} value={fNum(total, 0)} />
                <Stat label={T('sug.moq')} value={fNum(moq, 0)} tone={moq !== null && total < moq ? 'bad' : 'ok'} hint={moq !== null && total < moq ? T('sug.moqShort', { n: fNum(moq - total, 0) }) : T('sug.moqMet')} />
                <Stat label={T('sug.priceBreak')} value={reached ? `%${fNum(reached.discount_pct, 2)}` : '—'} hint={reached ? T('sug.breakFrom', { n: fNum(reached.min_qty, 0) }) : undefined} />
                <Stat label={T('sug.nextBreak')} value={next ? `%${fNum(next.discount_pct, 2)}` : '—'} hint={next ? T('sug.breakNeed', { n: fNum(Number(next.min_qty) - total, 0) }) : undefined} />
              </div>
            ) : null}
            <ul className="divide-y divide-line">
              {items.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-suggestion={s.id}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{s.sku} · {s.item_name} <StatusBadge value={s.state} /> <Badge>{E(s.reason)}</Badge></p>
                    <p className="mt-1 text-xl font-bold tabular-nums">{fNum(s.final_qty ?? s.qty, 0)} <span className="text-sm font-normal text-muted">({fNum(s.pallets, 1)} {T('ship.palletUnit')}) · {T('sug.release')} {fDate(s.release_date)} · {T('sug.need')} {fDate(s.need_date)}</span></p>
                    <p className="mt-0.5 text-xs text-muted" data-testid="suggestion-inputs">{inputsLine(s)}</p>
                    {s.edit_reason ? <p className="mt-0.5 text-xs text-warn">{T('sug.editReason')}: {s.edit_reason}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button small variant="ghost" onClick={() => setDetail(s)}>{T('sug.inputs')}</Button>
                    {may && s.state === 'proposed' ? (
                      <>
                        <Button small variant="primary" disabled={act.busy} data-testid="accept-suggestion" onClick={() => void act.run(() => decide(s.id, 'accept'))}>{T('sug.accept')}</Button>
                        <Button small variant="ghost" onClick={() => setEditing(s)}>{T('sug.edit')}</Button>
                        <Button small variant="danger" onClick={() => setRejecting(s)}>{T('sug.reject')}</Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      {editing ? (
        <FormModal title={T('sug.edit')} fields={[{ key: 'qty', type: 'number', required: true, min: 0.001 }, { key: 'reason', type: 'textarea', required: true }]} initial={{ qty: editing.qty }} onClose={() => setEditing(null)}
          onSubmit={async (d) => { await decide(editing.id, 'edit', d.qty, d.reason); setEditing(null); }} />
      ) : null}
      {rejecting ? <ReasonModal title={T('sug.reject')} onClose={() => setRejecting(null)} onSubmit={async (reason) => { await decide(rejecting.id, 'reject', null, reason); setRejecting(null); }} /> : null}
      {detail ? <FormModal title={T('sug.inputs')} fields={[]} onClose={() => setDetail(null)} onSubmit={async () => setDetail(null)} submitLabel={T('c.ok')}><Json value={detail.inputs} /></FormModal> : null}
    </div>
  );
}

function Projection() {
  const lk = useLookups(['item', 'plan_version']);
  const plan = useLoad(() => rows('plan_version', (q) => q.eq('kind', 'plan').eq('state', 'published').order('published_at', { ascending: false }).limit(1)).then((r) => r[0] ?? null), []);
  const [onlyBelow, setOnlyBelow] = useState(true);
  const list = useLoad(
    () => (plan.data ? rows('stock_projection', (q) => (onlyBelow ? q.eq('below_safety', true) : q).eq('plan_version_id', plan.data!.id).order('week').limit(3000)) : Promise.resolve(plan.loading ? undefined : ([] as Row[]))),
    [plan.data?.id ?? '', onlyBelow, plan.loading],
  );
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('plan.projectionHelp', { plan: plan.data?.name ?? '—' })}</p>
      <DataTable
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('plan.noProjection')}
        toolbar={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyBelow} onChange={(e) => setOnlyBelow(e.target.checked)} className="h-4 w-4" />{T('plan.onlyBelow')}</label>}
        columns={withLookups([
          { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'week', type: 'date' },
          { key: 'projected_qty', type: 'num', render: (r) => <span className={r.below_safety ? 'font-bold text-brand' : ''}>{fNum(r.projected_qty)}</span> }, { key: 'safety_stock', type: 'num' }, { key: 'below_safety', type: 'bool' },
        ], lk)}
        actions={(r) => <Link className="text-xs font-semibold text-brand underline" href={`/orders?tab=atp&item=${r.item_id}`}>ATP</Link>}
      />
    </>
  );
}

function Plans() {
  const { role } = useProfile();
  const may = !!role && PLAN_ROLES.includes(role);
  const lk = useLookups(['user', 'supplier_lane', 'family', 'party']);
  const plans = useLoad(() => rows('plan_version', (q) => q.order('created_at', { ascending: false }).limit(200)), []);
  const act = useAction();
  const [scenario, setScenario] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-4">
      <Notice>{act.error}</Notice>
      <DataTable
        testId="plan-versions"
        rows={lk.ready ? plans.data : undefined}
        loading={plans.loading}
        error={plans.error}
        toolbar={may ? <Button variant="primary" onClick={() => setScenario(true)}>{T('plan.newScenario')}</Button> : undefined}
        columns={withLookups([
          { key: 'name' }, { key: 'kind', type: 'badge' }, { key: 'state', type: 'badge' }, { key: 'param_version', type: 'int' }, { key: 'published_at', type: 'datetime' },
          { key: 'signed_by', lookup: 'user' } as Column, { key: 'created_at', type: 'datetime' }, { key: 'context', type: 'json' },
        ], lk)}
        actions={(p) => (role === 'owner' && p.state === 'draft' && p.kind === 'plan' ? <Button small variant="primary" disabled={act.busy} onClick={() => void act.run(async () => { await rpc('rpc_plan_publish', { p_plan: p.id }); plans.reload(); })}>{T('plan.publish')}</Button> : null)}
      />
      <Card title={T('plan.scenarioJobs')}>
        <JobList kinds={['simulate_scenario']} version={version} />
      </Card>
      {scenario ? (
        <FormModal
          title={T('plan.newScenario')}
          lookups={lk}
          fields={[
            { key: 'kind', label: T('plan.scenarioKind'), type: 'select', required: true, options: [{ value: 'lead_time_change', label: T('plan.scLead') }, { value: 'demand_change', label: T('plan.scDemand') }] },
            { key: 'supplier_lane_id', type: 'select', required: true, show: (v) => v.kind === 'lead_time_change', options: lk.list('supplier_lane').map((l) => ({ value: String(l.id), label: `${l.supplier_id ? lk.label('party', l.supplier_id) : l.production_line} · ${l.quoted_lt_days} ${T('plan.days')}` })) },
            { key: 'days', label: T('plan.newLeadDays'), type: 'number', required: true, min: 0, show: (v) => v.kind === 'lead_time_change' },
            { key: 'family', label: T('plan.family'), type: 'select', required: true, show: (v) => v.kind === 'demand_change', options: lk.list('family').map((f) => ({ value: String(f.code), label: `${f.code} · ${f.name}` })) },
            { key: 'pct', label: T('plan.demandPct'), type: 'number', required: true, show: (v) => v.kind === 'demand_change' },
            { key: 'weeks', label: T('plan.weeks'), type: 'int', min: 1, show: (v) => v.kind === 'demand_change' },
          ]}
          initial={{ kind: 'lead_time_change' }}
          submitLabel={T('plan.runScenario')}
          onClose={() => setScenario(false)}
          onSubmit={async (d) => {
            const payload = d.kind === 'lead_time_change' ? { lead_time_change: { supplier_lane_id: d.supplier_lane_id, days: d.days } } : { demand_change: { family: d.family, pct: d.pct, ...(d.weeks ? { weeks: d.weeks } : {}) } };
            await rpc('rpc_enqueue_job', { p_kind: 'simulate_scenario', p_payload: payload });
            setScenario(false);
            setVersion((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function SlowStock() {
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('plan.slowHelp')}</p>
      <CrudTable
        config={{
          table: 'slow_stock', order: 'value_eur', ascending: false, lookups: ['item', 'lot', 'user'], empty: T('plan.noSlow'),
          columns: [
            { key: 'run_date', type: 'date' }, { key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'lot_id', label: T('stock.lot'), lookup: 'lot' }, { key: 'category', type: 'badge' },
            { key: 'qty_base', type: 'num' }, { key: 'cover_weeks', type: 'num' }, { key: 'value_eur', type: 'eur' }, { key: 'proposed_action', type: 'badge' }, { key: 'owner_id', lookup: 'user' }, { key: 'state', type: 'badge' },
          ],
          fields: [
            { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true, lockOnEdit: true }, { key: 'category', type: 'select', options: ['slow', 'obsolete', 'at_risk'], required: true, lockOnEdit: true },
            { key: 'proposed_action', type: 'select', options: ['free_goods_bundle', 'dealer_push', 'export_clearance', 'supplier_return', 'scrap'] },
            { key: 'owner_id', type: 'lookup', lookup: 'user' }, { key: 'state', type: 'select', options: ['open', 'actioned', 'dismissed'], required: true },
          ],
          defaults: { state: 'open', category: 'slow' },
        }}
      />
    </>
  );
}

function Ddmrp() {
  const lk = useLookups(['item']);
  const list = useLoad(async () => {
    const latest = await rows('ddmrp_buffer', (q) => q.order('as_of', { ascending: false }).limit(1), 'as_of');
    return latest[0] ? rows('ddmrp_buffer', (q) => q.eq('as_of', latest[0].as_of).limit(3000)) : [];
  }, []);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('plan.ddmrpHelp')}</p>
      <DataTable
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('plan.noDdmrp')}
        columns={withLookups([
          { key: 'as_of', type: 'date' }, { key: 'item_id', label: T('c.item'), lookup: 'item' } as Column, { key: 'adu', type: 'num' }, { key: 'dlt_days', type: 'num' },
          { key: 'red', type: 'num' }, { key: 'yellow', type: 'num' }, { key: 'green', type: 'num' }, { key: 'on_hand', type: 'num' }, { key: 'net_flow', type: 'num' },
          { key: 'zone', render: (r) => <StatusBadge value={r.zone === 'yellow' ? 'amber' : r.zone} />, text: (r) => r.zone }, { key: 'suggested_qty', type: 'num' },
        ], lk)}
      />
    </>
  );
}

function JobRuns() {
  const { role } = useProfile();
  const may = !!role && [...PLAN_ROLES, 'finance'].includes(role);
  const runs = useLoad(() => rows('job_run', (q) => q.order('started_at', { ascending: false }).limit(300)), []);
  const [job, setJob] = useState('');
  const [version, setVersion] = useState(0);
  const act = useAction();
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <div className="space-y-4">
      <Card title={T('plan.trigger')}>
        <p className="mb-3 text-sm text-muted">{T('plan.triggerHelp')}</p>
        {may ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={T('plan.job')} className="w-72"><Select name="job" value={job} onChange={setJob} options={NIGHTLY.map((j) => ({ value: j, label: `${T(`job.${j}`)} (${j})` }))} /></Field>
            <Button variant="primary" disabled={!job || act.busy} data-testid="trigger-job" onClick={() => void act.run(async () => { await rpc('rpc_enqueue_job', { p_kind: 'run_job', p_payload: { jobs: [job], force: true } }); setVersion((n) => n + 1); })}>{T('plan.runJob')}</Button>
          </div>
        ) : <Notice tone="mute">{T('c.readOnly')}</Notice>}
        <div className="mt-3"><Notice>{act.error}</Notice></div>
        <div className="mt-3"><JobList kinds={['run_job']} version={version} limit={10} describe={(j) => ((j.payload?.jobs ?? [j.payload?.job]) as string[]).filter(Boolean).join(', ')} /></div>
      </Card>
      <Card title={T('plan.jobRuns')} actions={<Button small variant="ghost" onClick={runs.reload}>{T('c.refresh')}</Button>}>
        <DataTable rows={runs.data} loading={runs.loading} error={runs.error} empty={T('plan.noJobRuns')} onRowClick={setOpen} columns={[
          { key: 'started_at', type: 'datetime' }, { key: 'job', render: (r) => `${T(`job.${r.job}`).startsWith('⟦') ? r.job : T(`job.${r.job}`)}`, text: (r) => r.job }, { key: 'status', type: 'badge' }, { key: 'finished_at', type: 'datetime' },
          { key: 'stats', type: 'json' }, { key: 'error', render: (r) => (r.error ? <span className="text-brand">{String(r.error).slice(0, 100)}</span> : '—') },
        ]} />
      </Card>
      {open ? <FormModal title={String(open.job)} fields={[]} onClose={() => setOpen(null)} onSubmit={async () => setOpen(null)} submitLabel={T('c.ok')}>{open.error ? <Notice>{open.error}</Notice> : null}<Json value={open.stats} /></FormModal> : null}
    </div>
  );
}

export function PlanningScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'cycle', label: T('plan.tabs.cycle'), render: () => <Cycle /> },
        { id: 'classification', label: T('plan.tabs.classification'), render: () => <Classification /> },
        { id: 'forecast', label: T('plan.tabs.forecast'), render: () => <Forecast /> },
        { id: 'accuracy', label: T('plan.tabs.accuracy'), render: () => <Accuracy /> },
        { id: 'leadtimes', label: T('plan.tabs.leadtimes'), render: () => <LeadTimes /> },
        { id: 'params', label: T('plan.tabs.params'), render: () => <Params /> },
        { id: 'suggestions', label: T('plan.tabs.suggestions'), render: () => <Suggestions /> },
        { id: 'projection', label: T('plan.tabs.projection'), render: () => <Projection /> },
        { id: 'plans', label: T('plan.tabs.plans'), render: () => <Plans /> },
        { id: 'slow', label: T('plan.tabs.slow'), render: () => <SlowStock /> },
        { id: 'ddmrp', label: T('plan.tabs.ddmrp'), render: () => <Ddmrp /> },
        { id: 'jobs', label: T('plan.tabs.jobs'), render: () => <JobRuns /> },
      ]}
    />
  );
}
