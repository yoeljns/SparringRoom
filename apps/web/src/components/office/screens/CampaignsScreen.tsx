'use client';

import { useMemo, useState } from 'react';
import { validateMechanicParams } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import { CrudTable } from '../CrudTable';
import { DataTable, type Column } from '../DataTable';
import { ReasonModal } from '../Form';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, fDate, fDateTime, fEur, fNum, fRatio, L, T, todayIso } from '../i18n';
import { JobList } from '../Jobs';
import { useLookups, withLookups, type Lookups } from '../lookups';
import { parseAttrs, SchemaForm } from '../SchemaForm';
import { Badge, Button, Card, Drawer, Empty, Facts, Field, Json, Modal, Notice, Select, Stat, StatusBadge, Tabs, inputCls } from '../ui';

const STATES = ['draft', 'simulated', 'approved', 'live', 'closed', 'reviewed', 'cancelled'];
const LIFECYCLE = ['draft', 'simulated', 'approved', 'live', 'closed', 'reviewed'];
const EDIT_ROLES = ['planner', 'ops_manager', 'owner'];

interface ScopeDraft {
  itemMode: 'all' | 'family' | 'attributes' | 'items';
  family: string;
  attrs: string;
  item_ids: string[];
  partyMode: 'all' | 'segments' | 'type' | 'parties';
  segments: string[];
  partyType: string;
  party_ids: string[];
  market_ids: string[];
}
interface MechDraft { mechanic_type: string; params: Row }
interface OverrideDraft extends MechDraft { party_id: string }
interface Draft {
  id?: string; code: string; name: string; type: string; order_from: string; order_to: string; deliver_from: string; deliver_to: string;
  budget_eur: string; amber: boolean; note: string; scopes: ScopeDraft[]; mechanics: MechDraft[]; overrides: OverrideDraft[];
}

const emptyScope = (): ScopeDraft => ({ itemMode: 'all', family: '', attrs: '', item_ids: [], partyMode: 'all', segments: [], partyType: 'dealer', party_ids: [], market_ids: [] });

export function scopeFromDb(s: Row): ScopeDraft {
  const ir: Row = s.item_rule ?? {};
  const pr: Row = s.party_rule ?? {};
  return {
    itemMode: Array.isArray(ir.item_ids) ? 'items' : ir.family ? 'family' : ir.attributes ? 'attributes' : 'all',
    family: ir.family ?? '', attrs: ir.attributes ? Object.entries(ir.attributes as Row).map(([k, v]) => `${k}=${v}`).join(', ') : '', item_ids: ir.item_ids ?? [],
    partyMode: Array.isArray(pr.party_ids) ? 'parties' : Array.isArray(pr.segments) ? 'segments' : pr.type ? 'type' : 'all',
    segments: pr.segments ?? [], partyType: pr.type ?? 'dealer', party_ids: pr.party_ids ?? [], market_ids: s.market_ids ?? [],
  };
}

/** Scope rules in the form app.rule_matches_item / rule_matches_party read. */
export function scopeToDb(s: ScopeDraft): Row {
  const item_rule = s.itemMode === 'items' ? { item_ids: s.item_ids } : s.itemMode === 'family' ? { family: s.family } : s.itemMode === 'attributes' ? { attributes: parseAttrs(s.attrs) ?? {} } : { all: true };
  const party_rule = s.partyMode === 'parties' ? { party_ids: s.party_ids } : s.partyMode === 'segments' ? { segments: s.segments } : s.partyMode === 'type' ? { type: s.partyType } : { all: true };
  return { item_rule, party_rule, ...(s.market_ids.length ? { market_ids: s.market_ids } : {}) };
}

function Multi({ value, onChange, options, name, size = 4 }: { value: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[]; name: string; size?: number }) {
  return (
    <select multiple name={name} size={size} className={`${inputCls} h-auto py-1`} value={value} onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ScopeEditor({ scope, onChange, lk, index }: { scope: ScopeDraft; onChange: (s: ScopeDraft) => void; lk: Lookups; index: number }) {
  const set = (patch: Partial<ScopeDraft>) => onChange({ ...scope, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border border-line bg-surface p-3 md:grid-cols-3" data-scope={index}>
      <div className="space-y-2">
        <Field label={T('camp.itemScope')}>
          <Select name={`scope.${index}.itemMode`} value={scope.itemMode} placeholder={null} onChange={(v) => set({ itemMode: v as ScopeDraft['itemMode'] })} options={(['all', 'family', 'attributes', 'items'] as const).map((m) => ({ value: m, label: T(`camp.itemMode.${m}`) }))} />
        </Field>
        {scope.itemMode === 'family' ? <Select name={`scope.${index}.family`} value={scope.family} onChange={(v) => set({ family: v })} options={lk.list('family').map((f) => ({ value: String(f.code), label: `${f.code} · ${f.name}` }))} /> : null}
        {scope.itemMode === 'attributes' ? <input name={`scope.${index}.attrs`} className={inputCls} placeholder="colour=Beyaz, format=SOS" value={scope.attrs} onChange={(e) => set({ attrs: e.target.value })} /> : null}
        {scope.itemMode === 'items' ? <Multi name={`scope.${index}.items`} value={scope.item_ids} onChange={(v) => set({ item_ids: v })} options={lk.options('item')} size={6} /> : null}
      </div>
      <div className="space-y-2">
        <Field label={T('camp.partyScope')}>
          <Select name={`scope.${index}.partyMode`} value={scope.partyMode} placeholder={null} onChange={(v) => set({ partyMode: v as ScopeDraft['partyMode'] })} options={(['all', 'segments', 'type', 'parties'] as const).map((m) => ({ value: m, label: T(`camp.partyMode.${m}`) }))} />
        </Field>
        {scope.partyMode === 'segments' ? <Multi name={`scope.${index}.segments`} value={scope.segments} onChange={(v) => set({ segments: v })} options={['A', 'B', 'C'].map((s) => ({ value: s, label: T('schema.segment', { s }) }))} size={3} /> : null}
        {scope.partyMode === 'type' ? <Select value={scope.partyType} placeholder={null} onChange={(v) => set({ partyType: v })} options={['dealer', 'importer'].map((x) => ({ value: x, label: E(x) }))} /> : null}
        {scope.partyMode === 'parties' ? <Multi name={`scope.${index}.parties`} value={scope.party_ids} onChange={(v) => set({ party_ids: v })} options={lk.options('party', (p) => p.type === 'dealer' || p.type === 'importer')} size={6} /> : null}
      </div>
      <Field label={T('camp.markets')} hint={T('camp.marketsHint')}>
        <Multi name={`scope.${index}.markets`} value={scope.market_ids} onChange={(v) => set({ market_ids: v })} options={lk.options('market')} />
      </Field>
    </div>
  );
}

function obsText(o: unknown): string {
  if (typeof o === 'number') return fRatio(o);
  if (o && typeof o === 'object') {
    const r = o as Row;
    const v = r.observed ?? r.uplift ?? r.value;
    return `${r.campaign ?? r.code ?? ''} ${v !== undefined ? fRatio(v) : JSON.stringify(r)}${r.k !== undefined ? ` (k=${r.k})` : ''}`.trim();
  }
  return String(o);
}

/** Uplift prior, its range and the last five observations for the mechanic / family / segment (spec 9.6). */
function UpliftPrior({ mechanic, scopes, lk }: { mechanic: string; scopes: ScopeDraft[]; lk: Lookups }) {
  const lib = useLoad(() => (mechanic ? rows('uplift_library', (q) => q.eq('mechanic_type', mechanic).limit(500)) : Promise.resolve([] as Row[])), [mechanic]);
  const families = new Set(scopes.filter((s) => s.itemMode === 'family' && s.family).map((s) => lk.list('family').find((f) => f.code === s.family)?.id));
  const segments = new Set(scopes.flatMap((s) => (s.partyMode === 'segments' ? s.segments : [])));
  const matches = (lib.data ?? [])
    .filter((r) => (families.size === 0 || !r.family_id || families.has(r.family_id)) && (segments.size === 0 || !r.segment || segments.has(r.segment)))
    .slice(0, 4);
  return (
    <div className="rounded-md border border-line p-3" data-testid="uplift-prior">
      <p className="mb-2 text-xs font-bold uppercase text-muted">{T('camp.prior')}</p>
      {lib.error ? <Notice>{lib.error}</Notice> : null}
      {matches.length === 0 ? <p className="text-sm text-muted">{T('camp.noPrior')}</p> : matches.map((r) => (
        <div key={r.id} className="mb-2 text-sm">
          <p>
            <strong className="text-lg tabular-nums">{fRatio(r.prior_uplift)}</strong>{' '}
            <span className="text-muted">({T('camp.range')} {fRatio(r.prior_low)} – {fRatio(r.prior_high)}, n={fNum(r.n_obs, 2)})</span>{' '}
            <Badge>{r.family_id ? lk.label('family', r.family_id) : T('c.all')}</Badge> <Badge>{r.segment ? T('schema.segment', { s: r.segment }) : T('camp.allSegments')}</Badge> <Badge>{r.depth_band ?? 'na'}</Badge>
          </p>
          <p className="text-xs text-muted">{T('camp.lastObs')}: {Array.isArray(r.last_obs) && r.last_obs.length ? (r.last_obs as unknown[]).slice(-5).map(obsText).join(' · ') : T('camp.noObs')}</p>
        </div>
      ))}
    </div>
  );
}

function MechanicEditor({ mech, onChange, onRemove, lk, name, scopes, showPrior }: {
  mech: MechDraft; onChange: (m: MechDraft) => void; onRemove: () => void; lk: Lookups; name: string; scopes: ScopeDraft[]; showPrior?: boolean;
}) {
  const type = lk.list('mechanic_type').find((m) => m.code === mech.mechanic_type);
  return (
    <div className="space-y-3 rounded-md border border-line p-3" data-mechanic={name}>
      <div className="flex items-end gap-2">
        <Field label={T('camp.mechanicType')} className="flex-1">
          <Select name={`${name}.type`} value={mech.mechanic_type} onChange={(v) => onChange({ mechanic_type: v, params: {} })} options={lk.list('mechanic_type').filter((m) => m.active).map((m) => ({ value: String(m.code), label: `${E(m.code)} (${m.code})` }))} />
        </Field>
        <Button small variant="ghost" onClick={onRemove}>{T('c.remove')}</Button>
      </div>
      {type ? <SchemaForm key={mech.mechanic_type} prefix={name} schema={type.param_schema} value={mech.params} onChange={(params) => onChange({ ...mech, params })} lookups={lk} /> : null}
      {type && showPrior ? <UpliftPrior mechanic={mech.mechanic_type} scopes={scopes} lk={lk} /> : null}
    </div>
  );
}

function draftFrom(c: Row | null, scopes: Row[], mechs: Row[], overrides: Row[]): Draft {
  return {
    id: c?.id, code: c?.code ?? '', name: c?.name ?? '', type: c?.type ?? 'promotion', order_from: c?.order_from ?? todayIso(14), order_to: c?.order_to ?? todayIso(44),
    deliver_from: c?.deliver_from ?? '', deliver_to: c?.deliver_to ?? '', budget_eur: c?.budget_eur === null || c?.budget_eur === undefined ? '' : String(c.budget_eur), amber: c?.lot_preference === 'amber', note: c?.note ?? '',
    scopes: scopes.length ? scopes.map(scopeFromDb) : [emptyScope()],
    mechanics: mechs.length ? mechs.map((m) => ({ mechanic_type: m.mechanic_type, params: m.params ?? {} })) : [{ mechanic_type: '', params: {} }],
    overrides: overrides.map((o) => ({ party_id: o.party_id, mechanic_type: o.mechanic_type, params: o.params ?? {} })),
  };
}

function paramErrors(mechanic: string, params: Row): string[] {
  return validateMechanicParams(mechanic, params).map((msg) => {
    const m = /^([a-z_]+)[.:]/.exec(msg);
    return m ? `${L(m[1])}: ${T('camp.paramInvalid')}` : T('camp.paramInvalid');
  });
}

function validateDraft(d: Draft): string[] {
  const out: string[] = [];
  if (!d.code.trim()) out.push(T('camp.val.code'));
  if (!d.name.trim()) out.push(T('camp.val.name'));
  if (!d.order_from || !d.order_to || d.order_to < d.order_from) out.push(T('camp.val.dates'));
  if (d.deliver_from && d.deliver_to && d.deliver_to < d.deliver_from) out.push(T('camp.val.deliver'));
  if (d.budget_eur && !(Number(d.budget_eur.replace(',', '.')) >= 0)) out.push(T('camp.val.budget'));
  const mechs = d.mechanics.filter((m) => m.mechanic_type);
  if (mechs.length === 0) out.push(T('camp.val.mechanic'));
  for (const m of [...mechs, ...d.overrides]) {
    const errs = [...new Set(paramErrors(m.mechanic_type, m.params))];
    if (errs.length) out.push(`${E(m.mechanic_type)} — ${errs.join('; ')}`);
  }
  if (d.overrides.some((o) => !o.party_id || !o.mechanic_type)) out.push(T('camp.val.override'));
  d.scopes.forEach((s) => {
    if ((s.itemMode === 'family' && !s.family) || (s.itemMode === 'items' && s.item_ids.length === 0) || (s.itemMode === 'attributes' && !parseAttrs(s.attrs))) out.push(T('camp.val.itemScope'));
    if ((s.partyMode === 'segments' && s.segments.length === 0) || (s.partyMode === 'parties' && s.party_ids.length === 0)) out.push(T('camp.val.partyScope'));
  });
  return [...new Set(out)];
}

function CampaignEditor({ initial, lk, onClose, onSaved }: { initial: Draft; lk: Lookups; onClose: () => void; onSaved: (id: string) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const save = useAction();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const submit = () => {
    const found = validateDraft(d);
    setErrors(found);
    if (found.length) return;
    void save.run(async () => {
      const res = await rpc<Row>('rpc_campaign_save', {
        p: {
          ...(d.id ? { id: d.id } : {}), code: d.code.trim(), name: d.name.trim(), type: d.type, order_from: d.order_from, order_to: d.order_to,
          deliver_from: d.deliver_from || null, deliver_to: d.deliver_to || null, budget_eur: d.budget_eur ? Number(d.budget_eur.replace(',', '.')) : null,
          lot_preference: d.amber ? 'amber' : '', note: d.note || null,
          scopes: d.scopes.map(scopeToDb),
          mechanics: d.mechanics.filter((m) => m.mechanic_type).map((m) => ({ mechanic_type: m.mechanic_type, params: m.params })),
          dealer_overrides: d.overrides.map((o) => ({ party_id: o.party_id, mechanic_type: o.mechanic_type, params: o.params })),
        },
      });
      onSaved(String(res.campaign_id));
    });
  };
  const text = (key: keyof Draft, label: string, type = 'text', cls = '') => (
    <Field label={label} className={cls}><input name={key} type={type} className={inputCls} value={String(d[key] ?? '')} onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)} /></Field>
  );
  return (
    <Modal wide title={d.id ? T('camp.editTitle') : T('camp.newTitle')} onClose={onClose} footer={
      <>
        <Button variant="ghost" onClick={onClose}>{T('c.cancel')}</Button>
        <Button variant="primary" disabled={save.busy} onClick={submit} data-testid="save-campaign">{T('camp.saveDraft')}</Button>
      </>
    }>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {text('code', `${T('camp.code')} *`)}
        {text('name', `${T('camp.name')} *`, 'text', 'md:col-span-2')}
        <Field label={T('camp.type')}><Select name="type" value={d.type} placeholder={null} onChange={(v) => set({ type: v })} options={['promotion', 'launch', 'liquidation', 'export'].map((x) => ({ value: x, label: E(x) }))} /></Field>
        {text('order_from', `${T('camp.orderFrom')} *`, 'date')}
        {text('order_to', `${T('camp.orderTo')} *`, 'date')}
        {text('deliver_from', T('camp.deliverFrom'), 'date')}
        {text('deliver_to', T('camp.deliverTo'), 'date')}
        {text('budget_eur', T('camp.budget'))}
        <label className="flex items-center gap-2 self-end pb-2 text-sm md:col-span-3"><input type="checkbox" name="amber" checked={d.amber} onChange={(e) => set({ amber: e.target.checked })} className="h-4 w-4" />{T('camp.amber')}</label>
        {text('note', T('c.note'), 'text', 'md:col-span-4')}
      </div>

      <h4 className="mt-4 text-xs font-bold uppercase text-muted">{T('camp.scopes')}</h4>
      <p className="text-xs text-muted">{T('camp.scopesHelp')}</p>
      {d.scopes.map((s, i) => (
        <div key={i} className="space-y-1">
          <ScopeEditor index={i} scope={s} lk={lk} onChange={(next) => set({ scopes: d.scopes.map((x, j) => (j === i ? next : x)) })} />
          {d.scopes.length > 1 ? <Button small variant="ghost" onClick={() => set({ scopes: d.scopes.filter((_, j) => j !== i) })}>{T('c.remove')}</Button> : null}
        </div>
      ))}
      <Button small variant="ghost" onClick={() => set({ scopes: [...d.scopes, emptyScope()] })}>{T('camp.addScope')}</Button>

      <h4 className="mt-4 text-xs font-bold uppercase text-muted">{T('camp.mechanics')}</h4>
      {d.mechanics.map((m, i) => (
        <MechanicEditor key={i} name={`mech.${i}`} mech={m} lk={lk} scopes={d.scopes} showPrior onChange={(next) => set({ mechanics: d.mechanics.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ mechanics: d.mechanics.filter((_, j) => j !== i) })} />
      ))}
      <Button small variant="ghost" data-testid="add-mechanic" onClick={() => set({ mechanics: [...d.mechanics, { mechanic_type: '', params: {} }] })}>{T('camp.addMechanic')}</Button>

      <h4 className="mt-4 text-xs font-bold uppercase text-muted">{T('camp.overrides')}</h4>
      <p className="text-xs text-muted">{T('camp.overridesHelp')}</p>
      {d.overrides.map((o, i) => (
        <div key={i} className="space-y-2 rounded-md border border-dashed border-line-strong p-3">
          <Field label={T('c.party')}><Select name={`ovr.${i}.party`} value={o.party_id} onChange={(v) => set({ overrides: d.overrides.map((x, j) => (j === i ? { ...x, party_id: v } : x)) })} options={lk.options('party', (p) => p.type === 'dealer' || p.type === 'importer')} /></Field>
          <MechanicEditor name={`ovr.${i}`} mech={o} lk={lk} scopes={d.scopes} onChange={(next) => set({ overrides: d.overrides.map((x, j) => (j === i ? { ...x, ...next } : x)) })} onRemove={() => set({ overrides: d.overrides.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button small variant="ghost" onClick={() => set({ overrides: [...d.overrides, { party_id: '', mechanic_type: '', params: {} }] })}>{T('camp.addOverride')}</Button>

      {errors.length ? <Notice><ul className="ml-4 list-disc">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice> : null}
      <Notice>{save.error}</Notice>
    </Modal>
  );
}

function Lifecycle({ state }: { state: string }) {
  const at = LIFECYCLE.indexOf(state);
  return (
    <ol className="flex flex-wrap gap-1" data-testid="lifecycle">
      {LIFECYCLE.map((s, i) => (
        <li key={s} className={`rounded border px-2 py-1 text-xs font-semibold ${i < at ? 'border-ink bg-ink text-paper' : i === at ? 'border-brand bg-brand text-paper' : 'border-line bg-surface text-muted'}`}>{i + 1}. {E(s)}</li>
      ))}
      {state === 'cancelled' ? <li className="rounded border border-brand px-2 py-1 text-xs font-semibold text-brand">{E('cancelled')}</li> : null}
    </ol>
  );
}

function SimulationResult({ sim, lk }: { sim: Row; lk: Lookups }) {
  const r: Row = sim.result ?? {};
  const s: Row = r.summary ?? {};
  const items: Row[] = r.items ?? [];
  return (
    <div className="space-y-3" data-testid="simulation-result">
      <p className="text-xs text-muted">{T('camp.simAt', { at: fDateTime(sim.created_at) })} · {T('camp.simPlan')}: {lk.label('plan_version', sim.base_plan_version_id)}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={T('camp.sim.itemsBelow')} value={fNum(s.items_below_safety, 0)} tone={Number(s.items_below_safety) > 0 ? 'bad' : 'ok'} />
        <Stat label={T('camp.sim.prebuild')} value={fNum(s.prebuild_pallets, 0)} />
        <Stat label={T('camp.sim.amber')} value={fNum(s.amber_consumed, 0)} />
        <Stat label={T('camp.sim.trucks')} value={fNum(s.added_trucks_exact ?? s.added_trucks, 0)} />
        <Stat label={T('camp.sim.conflicts')} value={fNum(s.ring_fence_conflicts, 0)} tone={Number(s.ring_fence_conflicts) > 0 ? 'bad' : 'ok'} />
      </div>
      {r.campaign?.over_budget ? <Notice tone="warn">{T('camp.sim.overBudget', { cost: fEur(r.campaign.free_goods_cost_eur), budget: fEur(r.campaign.budget_eur) })}</Notice> : null}
      <DataTable search={false} rows={items} rowKey={(x) => String(x.item_id)} pageSize={50} empty={T('camp.sim.noItems')} columns={[
        { key: 'item_id', label: T('c.item'), render: (x) => lk.label('item', x.item_id) },
        { key: 'weeks_below_safety', label: T('camp.sim.weeksBelow'), type: 'int', render: (x) => <span className={Number(x.weeks_below_safety) > Number(x.weeks_below_safety_baseline ?? 0) ? 'font-bold text-brand' : ''}>{fNum(x.weeks_below_safety, 0)} <span className="text-xs text-muted">({T('camp.sim.baseline')} {fNum(x.weeks_below_safety_baseline, 0)})</span></span> },
        { key: 'prebuild_pallets', label: T('camp.sim.prebuild'), type: 'int' },
        { key: 'prebuild_by', label: T('camp.sim.prebuildBy'), render: (x) => (x.prebuild_by ? `${fDate(x.prebuild_by)}${x.prebuild_release_by ? ` (${T('camp.sim.releaseBy')} ${fDate(x.prebuild_release_by)})` : ''}` : '—') },
        { key: 'amber_consumed', label: T('camp.sim.amber'), type: 'num' },
        { key: 'added_trucks', label: T('camp.sim.trucks'), type: 'num' },
        { key: 'ring_fence_conflicts', label: T('camp.sim.conflicts'), render: (x) => ((x.ring_fence_conflicts ?? []) as Row[]).length === 0 ? '—' : <span className="text-brand">{((x.ring_fence_conflicts ?? []) as Row[]).map((c) => `${lk.label('campaign', c.campaign_id)} ${fDate(c.week)}`).join(', ')}</span> },
      ]} />
      <details><summary className="cursor-pointer text-sm text-muted">{T('jobs.raw')}</summary><Json value={r} /></details>
    </div>
  );
}

function CampaignDetail({ id, lk, onClose, onChanged, onEdit }: { id: string; lk: Lookups; onClose: () => void; onChanged: () => void; onEdit: (d: Draft) => void }) {
  const { role, profile } = useProfile();
  const mayEdit = !!role && EDIT_ROLES.includes(role);
  const camp = useLoad(() => rows('v_campaign', (q) => q.eq('id', id)).then((r) => r[0] ?? null), [id]);
  const parts = useLoad(async () => {
    const [scopes, mechs, overrides, sims, reviews, approvals] = await Promise.all([
      rows('campaign_scope', (q) => q.eq('campaign_id', id)), rows('campaign_mechanic', (q) => q.eq('campaign_id', id)), rows('campaign_dealer_override', (q) => q.eq('campaign_id', id)),
      rows('campaign_simulation', (q) => q.eq('campaign_id', id).order('created_at', { ascending: false }).limit(1)), rows('campaign_review', (q) => q.eq('campaign_id', id)),
      rows('approval_request', (q) => q.eq('entity_id', id).order('created_at', { ascending: false })),
    ]);
    return { scopes, mechs, overrides, sim: sims[0] ?? null, reviews, approvals };
  }, [id]);
  const act = useAction();
  const [version, setVersion] = useState(0);
  const [asking, setAsking] = useState(false);
  const c = camp.data;
  const p = parts.data;
  const reload = () => { camp.reload(); parts.reload(); onChanged(); };
  const editable = c && ['draft', 'simulated'].includes(c.state);
  const pendingApproval = (p?.approvals ?? []).find((a) => a.state === 'pending');
  const scopeText = (s: Row) => {
    const d = scopeFromDb(s);
    const items = d.itemMode === 'all' ? T('camp.itemMode.all') : d.itemMode === 'family' ? `${T('camp.itemMode.family')}: ${d.family}` : d.itemMode === 'attributes' ? `${T('camp.itemMode.attributes')}: ${d.attrs}` : d.item_ids.map((x) => lk.label('item', x)).join(', ');
    const parties = d.partyMode === 'all' ? T('camp.partyMode.all') : d.partyMode === 'segments' ? `${T('camp.partyMode.segments')}: ${d.segments.join(', ')}` : d.partyMode === 'type' ? E(d.partyType) : d.party_ids.map((x) => lk.label('party', x)).join(', ');
    return `${items} × ${parties}${d.market_ids.length ? ` × ${d.market_ids.map((m) => lk.label('market', m)).join(', ')}` : ''}`;
  };
  return (
    <Drawer wide title={c ? `${c.code} · ${c.name}` : T('camp.campaign')} onClose={onClose}>
      {camp.error ? <Notice>{camp.error}</Notice> : null}
      {c ? (
        <>
          <Lifecycle state={c.state} />
          <Facts items={[
            [T('camp.orderWindow'), `${fDate(c.order_from)} – ${fDate(c.order_to)}`], [T('camp.deliverWindow'), c.deliver_from ? `${fDate(c.deliver_from)} – ${fDate(c.deliver_to)}` : '—'], [T('camp.budget'), fEur(c.budget_eur)],
            [T('camp.forecastQty'), fNum(c.forecast_qty, 0)], [T('camp.forecastUplift'), fNum(c.forecast_uplift, 0)], [T('camp.actualQty'), fNum(c.actual_qty, 0)],
            [T('camp.lastSim'), c.last_simulated_at ? `${fDateTime(c.last_simulated_at)} ${c.simulation_current ? '' : `(${T('camp.simStale')})`}` : '—'],
            [T('camp.approvedAt'), fDateTime(c.approved_at)], [T('camp.owner'), lk.label('user', c.owner_id)],
          ]} />
          {mayEdit ? (
            <div className="flex flex-wrap gap-2">
              {editable ? <Button variant="ghost" onClick={() => p && onEdit(draftFrom(c, p.scopes, p.mechs, p.overrides))}>{T('c.edit')}</Button> : null}
              {editable ? <Button variant="primary" disabled={act.busy} data-testid="simulate" onClick={() => void act.run(async () => { await rpc('rpc_campaign_simulate', { p_campaign: id }); setVersion((n) => n + 1); })}>{T('camp.simulate')}</Button> : null}
              {c.state === 'simulated' && !pendingApproval ? <Button variant="dark" onClick={() => setAsking(true)} data-testid="request-approval">{T('camp.requestApproval')}</Button> : null}
            </div>
          ) : null}
          <Notice>{act.error}</Notice>
          {pendingApproval ? <Notice tone="warn">{T('camp.approvalPending')}{pendingApproval.requested_by === profile?.id ? ` ${T('camp.ownApproval')}` : ''}</Notice> : null}
        </>
      ) : null}
      {p ? (
        <>
          <Card title={T('camp.scopes')}><ul className="list-disc pl-5 text-sm">{p.scopes.map((s) => <li key={s.id}>{scopeText(s)}</li>)}</ul></Card>
          <Card title={T('camp.mechanics')}>
            <ul className="space-y-2 text-sm" data-testid="campaign-mechanics">
              {p.mechs.map((m) => <li key={m.id}><Badge tone="dark">{E(m.mechanic_type)}</Badge> <code className="text-xs">{JSON.stringify(m.params)}</code></li>)}
              {p.overrides.map((o) => <li key={o.id}><Badge tone="warn">{T('camp.override')}</Badge> {lk.label('party', o.party_id)} · {E(o.mechanic_type)} <code className="text-xs">{JSON.stringify(o.params)}</code></li>)}
            </ul>
          </Card>
          <Card title={T('camp.simulation')}>
            <JobList kinds={['simulate_campaign']} version={version} limit={30} describe={(j) => lk.label('campaign', j.payload?.campaign_id)} />
            <div className="mt-4">{p.sim ? <SimulationResult sim={p.sim} lk={lk} /> : <Empty>{T('camp.noSim')}</Empty>}</div>
            <div className="mt-2"><Button small variant="ghost" onClick={reload}>{T('c.refresh')}</Button></div>
          </Card>
          <Card title={T('camp.review')}>
            <p className="mb-2 text-sm text-muted">{T('camp.reviewHelp')}</p>
            <DataTable search={false} rows={p.reviews} empty={T('camp.noReview')} columns={[
              { key: 'item_id', label: T('c.item'), render: (r) => (r.item_id ? lk.label('item', r.item_id) : T('c.total')) },
              { key: 'gross', type: 'num' }, { key: 'borrowed', type: 'num' }, { key: 'cannibalised', type: 'num' }, { key: 'net', type: 'num', render: (r) => <strong>{fNum(r.net)}</strong> },
              { key: 'forecast_net', type: 'num' }, { key: 'confidence', type: 'badge' },
            ]} />
          </Card>
        </>
      ) : parts.error ? <Notice>{parts.error}</Notice> : null}
      {asking ? (
        <ReasonModal title={T('camp.requestApproval')} label={T('c.note')} required={false} confirmLabel={T('c.sendForApproval')} onClose={() => setAsking(false)} onSubmit={async (note) => { await rpc('rpc_campaign_request_approval', { p_campaign: id, p_note: note || null }); setAsking(false); reload(); }} />
      ) : null}
    </Drawer>
  );
}

/** Next 13 weeks; one bar per campaign over its order window. */
function Calendar({ campaigns, onOpen }: { campaigns: Row[]; onOpen: (id: string) => void }) {
  const start = new Date(`${todayIso()}T00:00:00Z`);
  const days = 91;
  const end = new Date(start.getTime() + days * 86400000);
  const visible = campaigns.filter((c) => c.state !== 'cancelled' && new Date(`${c.order_to}T00:00:00Z`) >= start && new Date(`${c.order_from}T00:00:00Z`) <= end);
  const months = [0, 1, 2].map((i) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)));
  return (
    <Card title={T('camp.calendar')}>
      <div className="relative" data-testid="campaign-calendar">
        <div className="mb-2 flex text-xs font-semibold text-muted">
          {months.map((m) => <span key={m.toISOString()} className="flex-1 border-l border-line pl-1">{new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(m)}</span>)}
        </div>
        {visible.length === 0 ? <Empty>{T('camp.calendarEmpty')}</Empty> : visible.map((c) => {
          const from = Math.max(0, (new Date(`${c.order_from}T00:00:00Z`).getTime() - start.getTime()) / 86400000);
          const to = Math.min(days, (new Date(`${c.order_to}T00:00:00Z`).getTime() - start.getTime()) / 86400000 + 1);
          const tone = c.state === 'live' ? 'bg-brand text-paper' : c.state === 'approved' ? 'bg-ink text-paper' : 'bg-surface text-ink border border-line-strong';
          return (
            <div key={c.id} className="relative mb-1 h-7">
              <button type="button" onClick={() => onOpen(String(c.id))} title={`${c.name} · ${fDate(c.order_from)} – ${fDate(c.order_to)}`} className={`absolute top-0 h-7 truncate rounded px-2 text-left text-xs font-semibold ${tone}`} style={{ left: `${(from / days) * 100}%`, width: `${Math.max(3, ((to - from) / days) * 100)}%` }}>
                {c.code} · {E(c.state)}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CampaignList() {
  const { role } = useProfile();
  const mayEdit = !!role && EDIT_ROLES.includes(role);
  const lk = useLookups(['item', 'family', 'party', 'market', 'bundle', 'mechanic_type', 'user', 'plan_version', 'campaign']);
  const [state, setState] = useUrlParam('state');
  const [openId, setOpenId] = useUrlParam('id');
  const list = useLoad(() => rows('v_campaign', (q) => q.order('order_from', { ascending: false }).limit(500)), []);
  const [editing, setEditing] = useState<Draft | null>(null);
  const shown = useMemo(() => (list.data ?? []).filter((c) => !state || c.state === state), [list.data, state]);
  return (
    <div className="space-y-4">
      <Calendar campaigns={list.data ?? []} onOpen={(id) => setOpenId(id)} />
      <DataTable
        testId="campaign-list"
        rows={list.data ? shown : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('camp.empty')}
        onRowClick={(r) => setOpenId(String(r.id))}
        toolbar={
          <>
            <div className="w-44"><Select value={state} onChange={(v) => setState(v)} placeholder={T('c.allStates')} options={STATES.map((s) => ({ value: s, label: E(s) }))} /></div>
            {mayEdit ? <Button variant="primary" disabled={!lk.ready} onClick={() => setEditing(draftFrom(null, [], [], []))} data-testid="new-campaign">{T('camp.new')}</Button> : null}
          </>
        }
        columns={[
          { key: 'code', type: 'mono' }, { key: 'name' }, { key: 'type', type: 'badge' }, { key: 'state', type: 'badge' }, { key: 'order_from', type: 'date' }, { key: 'order_to', type: 'date' },
          { key: 'forecast_qty', type: 'int' }, { key: 'actual_qty', type: 'int' }, { key: 'budget_eur', type: 'eur' },
          { key: 'simulation_current', label: T('camp.simCurrent'), render: (r) => (r.last_simulated_at ? (r.simulation_current ? <Badge tone="ok">{T('c.yes')}</Badge> : <Badge tone="warn">{T('camp.simStale')}</Badge>) : '—') },
        ]}
      />
      {openId && !editing ? <CampaignDetail id={openId} lk={lk} onClose={() => setOpenId('')} onChanged={list.reload} onEdit={setEditing} /> : null}
      {editing ? <CampaignEditor initial={editing} lk={lk} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); list.reload(); setOpenId(id); }} /> : null}
    </div>
  );
}

function Bundles() {
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('camp.bundlesHelp')}</p>
      <CrudTable config={{
        table: 'bundle', order: 'name', lookups: ['item'], onRowClick: setOpen,
        columns: [{ key: 'name' }, { key: 'item_id', label: T('camp.bundleItem'), lookup: 'item' }, { key: 'kind', type: 'badge' }, { key: 'active', type: 'bool' }],
        fields: [{ key: 'name', required: true }, { key: 'item_id', label: T('camp.bundleItem'), type: 'lookup', lookup: 'item', required: true }, { key: 'kind', type: 'select', options: ['phantom', 'prebuilt'], required: true }, { key: 'active', type: 'bool' }],
        defaults: { kind: 'phantom', active: true },
      }} />
      {open ? (
        <Drawer title={`${T('camp.bundle')}: ${open.name}`} onClose={() => setOpen(null)}>
          <CrudTable config={{
            table: 'bundle_line', filter: { bundle_id: open.id }, lookups: ['item'], deletable: true,
            columns: [{ key: 'component_item_id', label: T('camp.component'), lookup: 'item' }, { key: 'qty', type: 'num' }],
            fields: [{ key: 'component_item_id', label: T('camp.component'), type: 'lookup', lookup: 'item', required: true }, { key: 'qty', type: 'number', required: true, min: 0.001 }],
          }} />
        </Drawer>
      ) : null}
    </>
  );
}

function Terms() {
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('camp.termsHelp')}</p>
      <CrudTable config={{
        table: 'standard_terms', order: 'valid_from', ascending: false, deletable: true,
        columns: [{ key: 'name' }, { key: 'scope', type: 'json' }, { key: 'terms', type: 'json' }, { key: 'valid_from', type: 'date' }, { key: 'valid_to', type: 'date' }],
        fields: [{ key: 'name', required: true }, { key: 'valid_from', type: 'date', required: true }, { key: 'valid_to', type: 'date' }, { key: 'scope', type: 'json', required: true, hint: '{"type":"dealer"}' }, { key: 'terms', type: 'json', required: true, hint: '{"list_discount_pct":20,"free_goods_ratio":0}' }],
        defaults: { scope: { all: true }, terms: {}, valid_from: todayIso() },
      }} />
    </>
  );
}

function Uplift() {
  const lk = useLookups(['family']);
  const list = useLoad(() => rows('uplift_library', (q) => q.order('mechanic_type').limit(2000)), []);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('camp.upliftHelp')}</p>
      <DataTable rows={lk.ready ? list.data : undefined} loading={list.loading} error={list.error} empty={T('camp.noUplift')} columns={withLookups([
        { key: 'mechanic_type', type: 'badge' }, { key: 'family_id', label: T('plan.family'), lookup: 'family' } as Column, { key: 'segment' }, { key: 'depth_band' },
        { key: 'prior_uplift', type: 'ratio' }, { key: 'prior_low', type: 'ratio' }, { key: 'prior_high', type: 'ratio' }, { key: 'n_obs', type: 'num' },
        { key: 'last_obs', label: T('camp.lastObs'), render: (r) => (Array.isArray(r.last_obs) && r.last_obs.length ? (r.last_obs as unknown[]).slice(-5).map(obsText).join(' · ') : '—') },
        { key: 'updated_at', type: 'datetime' },
      ], lk)} />
    </>
  );
}

export function CampaignsScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'list', label: T('camp.tabs.list'), render: () => <CampaignList /> },
        { id: 'bundles', label: T('camp.tabs.bundles'), render: () => <Bundles /> },
        { id: 'terms', label: T('camp.tabs.terms'), render: () => <Terms /> },
        { id: 'uplift', label: T('camp.tabs.uplift'), render: () => <Uplift /> },
      ]}
    />
  );
}
