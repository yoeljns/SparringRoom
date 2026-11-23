'use client';

import { useState } from 'react';
import { ROLES } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { downloadTextFile, rows, rpc, upsert, type Row } from '@/lib/data/office-db';
import { CrudTable, MASTER_ROLES } from '../CrudTable';
import { DataTable, type Column } from '../DataTable';
import { FormFields, FormModal, toFormValues, validateForm, type FieldDef, type FormValues } from '../Form';
import { useAction, useLoad } from '../hooks';
import { errText, T } from '../i18n';
import { invalidateLookup, useLookups, withLookups } from '../lookups';
import { SchemaForm } from '../SchemaForm';
import { Button, Card, Drawer, Modal, Notice, Tabs } from '../ui';

const ITEM_FIELDS: FieldDef[] = [
  { key: 'sku', required: true }, { key: 'name', required: true, wide: true },
  { key: 'family_id', label: T('plan.family'), type: 'lookup', lookup: 'family', required: true }, { key: 'gtin' }, { key: 'brand' },
  { key: 'base_uom', type: 'select', options: ['piece', 'carton', 'pallet'], required: true }, { key: 'lifecycle', type: 'select', options: ['launch', 'growth', 'mature', 'phase_out'], required: true },
  { key: 'shelf_life_days', type: 'int', min: 0 }, { key: 'max_stack_height', type: 'int', min: 1 }, { key: 'zone' }, { key: 'depth_class', type: 'int' }, { key: 'production_line' },
  { key: 'logo_item_code' }, { key: 'analog_item_id', type: 'lookup', lookup: 'item' }, { key: 'replaces_item_id', type: 'lookup', lookup: 'item' }, { key: 'volume_justification' },
  { key: 'lot_expiry_controlled', type: 'bool' }, { key: 'sellable', type: 'bool' }, { key: 'export_contract', type: 'bool' }, { key: 'active', type: 'bool' }, { key: 'needs_review', type: 'bool' },
];

/** Item form: fixed columns plus the attribute form generated from the family's attr_schema. */
function ItemEditor({ item, onClose, onSaved }: { item: Row | null; onClose: () => void; onSaved: () => void }) {
  const lk = useLookups(['family', 'item', 'bundle', 'market']);
  const [values, setValues] = useState<FormValues>(() => toFormValues(ITEM_FIELDS, item ?? { base_uom: 'piece', lifecycle: 'mature', sellable: true, active: true }));
  const [attrs, setAttrs] = useState<Row>(item?.attributes ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useAction();
  const family = lk.get('family', values.family_id);
  const submit = () => {
    const { data, errors: found } = validateForm(ITEM_FIELDS, values);
    setErrors(found);
    if (!data) return;
    void save.run(async () => {
      await upsert('item', { ...data, attributes: attrs, ...(item ? { id: item.id } : {}) });
      invalidateLookup('item');
      onSaved();
    });
  };
  return (
    <Modal wide title={item ? T('masters.editItem') : T('masters.newItem')} onClose={onClose} footer={
      <>
        <Button variant="ghost" onClick={onClose}>{T('c.cancel')}</Button>
        <Button variant="primary" disabled={save.busy} onClick={submit} data-testid="save-item">{T('c.save')}</Button>
      </>
    }>
      <FormFields fields={ITEM_FIELDS} values={values} errors={errors} lookups={lk} editing={!!item} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
      <h4 className="mt-2 text-xs font-bold uppercase text-muted">{T('masters.attributes')} {family ? `· ${family.code}` : ''}</h4>
      {family?.sku_pattern ? <p className="text-xs text-muted">{T('masters.skuPattern')}: <code>{family.sku_pattern}</code></p> : null}
      {family ? <div data-testid="attr-form"><SchemaForm key={String(family.id)} prefix="attr" schema={family.attr_schema} value={attrs} onChange={setAttrs} lookups={lk} /></div> : <p className="text-sm text-muted">{T('masters.pickFamily')}</p>}
      <Notice>{save.error}</Notice>
    </Modal>
  );
}

function Items() {
  const { role } = useProfile();
  const mayEdit = !!role && MASTER_ROLES.includes(role);
  const lk = useLookups(['family']);
  const [version, setVersion] = useState(0);
  const list = useLoad(() => rows('item', (q) => q.order('sku').limit(5000)), [version]);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [packs, setPacks] = useState<Row | null>(null);
  return (
    <>
      <DataTable
        testId="item-list"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        toolbar={mayEdit ? <Button variant="primary" onClick={() => setEditing('new')} data-testid="add-item">{T('masters.newItem')}</Button> : undefined}
        columns={withLookups([
          { key: 'sku', type: 'mono' }, { key: 'name' }, { key: 'family_id', label: T('plan.family'), lookup: 'family' } as Column, { key: 'attributes', type: 'json' }, { key: 'base_uom', type: 'badge' },
          { key: 'gtin', type: 'mono' }, { key: 'lifecycle', type: 'badge' }, { key: 'shelf_life_days', type: 'int' }, { key: 'sellable', type: 'bool' }, { key: 'active', type: 'bool' }, { key: 'needs_review', type: 'bool' },
        ], lk)}
        actions={(r) => (
          <>
            <Button small variant="ghost" onClick={() => setPacks(r)}>{T('masters.packs')}</Button>
            {mayEdit ? <Button small variant="ghost" onClick={() => setEditing(r)}>{T('c.edit')}</Button> : null}
          </>
        )}
      />
      {editing ? <ItemEditor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion((n) => n + 1); }} /> : null}
      {packs ? (
        <Drawer wide title={`${packs.sku} · ${T('masters.packs')}`} onClose={() => setPacks(null)}>
          <Card title={T('masters.uomPack')}>
            <CrudTable config={{
              table: 'uom_pack', filter: { item_id: packs.id }, order: 'qty_base', deletable: true,
              columns: [{ key: 'level', type: 'badge' }, { key: 'qty_base', type: 'num' }, { key: 'gross_kg', type: 'num' }, { key: 'length_mm', type: 'int' }, { key: 'width_mm', type: 'int' }, { key: 'height_mm', type: 'int' }, { key: 'logo_unit' }],
              fields: [
                { key: 'level', type: 'select', options: ['piece', 'carton', 'pallet'], required: true }, { key: 'qty_base', type: 'number', required: true, min: 0.001 }, { key: 'gross_kg', type: 'number', min: 0 },
                { key: 'length_mm', type: 'int' }, { key: 'width_mm', type: 'int' }, { key: 'height_mm', type: 'int' }, { key: 'logo_unit' },
              ],
            }} />
          </Card>
          <Card title={T('masters.packConfig')}>
            <CrudTable config={{
              table: 'pack_config', filter: { item_id: packs.id }, order: 'code', deletable: true,
              columns: [{ key: 'code', type: 'mono' }, { key: 'pallet_type' }, { key: 'units_per_pallet', type: 'num' }, { key: 'gross_kg', type: 'num' }, { key: 'footprint' }, { key: 'stack_height', type: 'int' }, { key: 'is_default', type: 'bool' }],
              fields: [
                { key: 'code', required: true }, { key: 'pallet_type', required: true }, { key: 'units_per_pallet', type: 'number', required: true, min: 0.001 }, { key: 'gross_kg', type: 'number', min: 0 },
                { key: 'footprint' }, { key: 'stack_height', type: 'int' }, { key: 'is_default', type: 'bool' },
              ],
              defaults: { pallet_type: 'EUR' },
            }} />
          </Card>
        </Drawer>
      ) : null}
    </>
  );
}

async function label(code: string, mode: 'download' | 'print'): Promise<string> {
  const res = await fetch('/api/labels/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: 'location', data: { code }, copies: 1, mode }) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(T(`masters.labelErr.${body.error ?? 'UNKNOWN'}`).startsWith('⟦') ? String(body.error ?? res.status) : T(`masters.labelErr.${body.error ?? 'UNKNOWN'}`));
  }
  if (mode === 'download') downloadTextFile(`${code}.zpl`, await res.text(), 'text/plain;charset=utf-8');
  return mode === 'download' ? T('masters.labelDownloaded', { code }) : T('masters.labelPrinted', { code });
}

function Locations() {
  const lk = useLookups(['site']);
  const [bulk, setBulk] = useState<(() => void) | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const doLabel = (code: string, mode: 'download' | 'print') => label(code, mode).then((text) => setMsg({ tone: 'ok', text }), (err: unknown) => setMsg({ tone: 'bad', text: err instanceof Error ? err.message : String(err) }));
  return (
    <>
      {msg ? <div className="mb-3"><Notice tone={msg.tone}><span data-testid="label-msg">{msg.text}</span></Notice></div> : null}
      <CrudTable config={{
        table: 'location', order: 'code', roles: ['owner', 'ops_manager'], lookups: ['site', 'item', 'lot', 'party'],
        columns: [
          { key: 'code', type: 'mono' }, { key: 'type', type: 'badge' }, { key: 'zone' }, { key: 'depth_positions', type: 'int' }, { key: 'max_stack_height', type: 'int' }, { key: 'depth_class', type: 'int' },
          { key: 'lane_item_id', lookup: 'item' }, { key: 'dealer_id', lookup: 'party' }, { key: 'pick_min_qty', type: 'num' }, { key: 'dock_distance', type: 'int' }, { key: 'last_counted_at', type: 'datetime' }, { key: 'active', type: 'bool' },
        ],
        fields: [
          { key: 'code', required: true, hint: T('masters.locCodeHint') }, { key: 'type', type: 'select', options: ['block_lane', 'pick_face', 'staging', 'dock', 'consignment'], required: true },
          { key: 'site_id', type: 'lookup', lookup: 'site' }, { key: 'zone' }, { key: 'depth_positions', type: 'int', min: 1 }, { key: 'max_stack_height', type: 'int', min: 1 }, { key: 'depth_class', type: 'int' },
          { key: 'dealer_id', type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'dealer', show: (v) => v.type === 'consignment' }, { key: 'pick_min_qty', type: 'number', min: 0, show: (v) => v.type === 'pick_face' },
          { key: 'dock_distance', type: 'int', min: 0 }, { key: 'active', type: 'bool' },
        ],
        defaults: { type: 'block_lane', active: true, site_id: lk.list('site')[0]?.id },
        toolbar: (reload, mayEdit) => (mayEdit ? <Button variant="ghost" onClick={() => setBulk(() => reload)} data-testid="bulk-lanes">{T('masters.bulkLanes')}</Button> : null),
        rowActions: (r) => (r.type === 'virtual' ? null : (
          <>
            <Button small variant="ghost" data-testid="label-download" onClick={() => void doLabel(r.code, 'download')}>{T('masters.labelDownload')}</Button>
            <Button small variant="ghost" onClick={() => void doLabel(r.code, 'print')}>{T('masters.labelPrint')}</Button>
          </>
        )),
      }} />
      {bulk ? (
        <FormModal
          title={T('masters.bulkLanes')}
          lookups={lk}
          fields={[
            { key: 'site_id', type: 'lookup', lookup: 'site', required: true }, { key: 'prefix', label: T('masters.blockPrefix'), required: true, hint: T('masters.blockPrefixHint') },
            { key: 'from', label: T('masters.laneFrom'), type: 'int', required: true, min: 1 }, { key: 'to', label: T('masters.laneTo'), type: 'int', required: true, min: 1 },
            { key: 'zone' }, { key: 'depth_positions', type: 'int', required: true, min: 1 }, { key: 'max_stack_height', type: 'int', required: true, min: 1 }, { key: 'depth_class', type: 'int' }, { key: 'dock_distance', type: 'int', hint: T('masters.dockHint') },
          ]}
          initial={{ site_id: lk.list('site')[0]?.id, prefix: 'TZ-B04', from: 1, to: 10, depth_positions: 4, max_stack_height: 1 }}
          submitLabel={T('masters.createLanes')}
          onClose={() => setBulk(null)}
          onSubmit={async (d) => {
            if (!/^[A-Z]{2}-B\d{2}$/.test(String(d.prefix))) throw new Error(T('masters.blockPrefixHint'));
            if (Number(d.to) < Number(d.from) || Number(d.to) > 99) throw new Error(T('masters.laneRange'));
            const created: string[] = [];
            const failed: string[] = [];
            for (let n = Number(d.from); n <= Number(d.to); n++) {
              const code = `${d.prefix}-L${String(n).padStart(2, '0')}`;
              try {
                await upsert('location', { site_id: d.site_id, code, type: 'block_lane', zone: d.zone, depth_positions: d.depth_positions, max_stack_height: d.max_stack_height, depth_class: d.depth_class, dock_distance: d.dock_distance === null ? null : Number(d.dock_distance) + n, active: true });
                created.push(code);
              } catch (err) {
                failed.push(`${code}: ${errText(err)}`);
              }
            }
            invalidateLookup('location');
            bulk();
            setBulk(null);
            setMsg({ tone: failed.length ? 'bad' : 'ok', text: `${T('masters.lanesCreated', { n: created.length })}${failed.length ? ` · ${failed.join(' · ')}` : ''}` });
          }}
        />
      ) : null}
    </>
  );
}

function Users() {
  const { role } = useProfile();
  const isOwner = role === 'owner';
  const list = useLoad(() => rows('app_user', (q) => q.order('full_name')), []);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const existing = editing && editing !== 'new' ? editing : null;
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('masters.usersHelp')}</p>
      <DataTable
        testId="user-list"
        rows={list.data}
        loading={list.loading}
        error={list.error}
        toolbar={isOwner ? <Button variant="primary" onClick={() => setEditing('new')}>{T('masters.addUser')}</Button> : undefined}
        columns={[{ key: 'full_name' }, { key: 'email' }, { key: 'role', type: 'badge' }, { key: 'active', type: 'bool' }, { key: 'telegram_chat_id', type: 'mono' }, { key: 'id', type: 'mono', render: (r) => <code className="text-xs">{String(r.id).slice(0, 8)}</code> }]}
        actions={isOwner ? (r) => <Button small variant="ghost" onClick={() => setEditing(r)}>{T('c.edit')}</Button> : undefined}
      />
      {editing ? (
        <FormModal
          title={existing ? T('masters.editUser') : T('masters.addUser')}
          editing={!!existing}
          fields={[
            { key: 'id', label: T('masters.authId'), required: true, lockOnEdit: true, hint: T('masters.authIdHint'), wide: true },
            { key: 'full_name', required: true }, { key: 'email' }, { key: 'role', type: 'select', options: [...ROLES], required: true }, { key: 'telegram_chat_id', hint: T('masters.telegramHint') }, { key: 'active', type: 'bool' },
          ]}
          initial={existing ?? { active: true }}
          onClose={() => setEditing(null)}
          onSubmit={async (d) => {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(d.id))) throw new Error(T('masters.authIdInvalid'));
            await rpc('rpc_set_user', { p_user: d.id, p_full_name: d.full_name, p_role: d.role, p_active: d.active, p_email: d.email });
            if ((d.telegram_chat_id ?? null) !== (existing?.telegram_chat_id ?? null)) await upsert('app_user', { id: d.id, telegram_chat_id: d.telegram_chat_id });
            invalidateLookup('app_user');
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

export function MastersScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'items', label: T('masters.tabs.items'), render: () => <Items /> },
        { id: 'families', label: T('masters.tabs.families'), render: () => (
          <CrudTable config={{
            table: 'item_family', order: 'code',
            columns: [{ key: 'code', type: 'mono' }, { key: 'name' }, { key: 'sku_pattern', type: 'mono' }, { key: 'default_policy', type: 'badge' }, { key: 'shelf_life_days', type: 'int' }, { key: 'group_attribute' }, { key: 'attr_schema', type: 'json' }],
            fields: [
              { key: 'code', required: true }, { key: 'name', required: true }, { key: 'sku_pattern', hint: T('masters.skuPatternHint') }, { key: 'default_policy', type: 'select', options: ['continuous', 'periodic', 'empirical', 'to_order'] },
              { key: 'shelf_life_days', type: 'int', min: 0 }, { key: 'group_attribute' }, { key: 'attr_schema', type: 'json', required: true, hint: T('masters.attrSchemaHint') },
            ],
            defaults: { attr_schema: { type: 'object', properties: {} } },
          }} />
        ) },
        { id: 'lots', label: T('masters.tabs.lots'), render: () => (
          <CrudTable config={{
            table: 'lot', order: 'expiry_date', roles: ['owner', 'ops_manager', 'qc'], lookups: ['item'],
            columns: [{ key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'lot_no', type: 'mono' }, { key: 'prod_date', type: 'date' }, { key: 'expiry_date', type: 'date' }, { key: 'qc_status', type: 'badge' }, { key: 'band', type: 'badge' }, { key: 'supplier_lot' }, { key: 'actual_pallet_kg', type: 'num' }, { key: 'band_override', type: 'json' }],
            fields: [
              { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true, lockOnEdit: true }, { key: 'lot_no', required: true, lockOnEdit: true }, { key: 'prod_date', type: 'date' }, { key: 'expiry_date', type: 'date' },
              { key: 'supplier_lot' }, { key: 'actual_pallet_kg', type: 'number', min: 0 }, { key: 'band_override', type: 'json', hint: T('masters.bandOverrideHint') },
            ],
          }} />
        ) },
        { id: 'locations', label: T('masters.tabs.locations'), render: () => <Locations /> },
        { id: 'parties', label: T('masters.tabs.parties'), render: () => (
          <CrudTable config={{
            table: 'party', order: 'name', lookups: ['market'],
            columns: [{ key: 'name' }, { key: 'type', type: 'badge' }, { key: 'segment' }, { key: 'market_id', lookup: 'market' }, { key: 'vkn', type: 'mono' }, { key: 'logo_cari_code', type: 'mono' }, { key: 'city' }, { key: 'country' }, { key: 'mrsl_profile' }, { key: 'priority_tier', type: 'int' }, { key: 'consignment', type: 'bool' }, { key: 'active', type: 'bool' }],
            fields: [
              { key: 'name', required: true, wide: true }, { key: 'type', type: 'select', options: ['dealer', 'supplier', 'importer'], required: true }, { key: 'segment', type: 'select', options: ['A', 'B', 'C'].map((s) => ({ value: s, label: s })) },
              { key: 'market_id', type: 'lookup', lookup: 'market' }, { key: 'vkn' }, { key: 'logo_cari_code' }, { key: 'city' }, { key: 'country' }, { key: 'mrsl_profile' }, { key: 'priority_tier', type: 'int', min: 1 },
              { key: 'consignment', type: 'bool' }, { key: 'short_cycle', type: 'bool' }, { key: 'active', type: 'bool' },
            ],
            defaults: { type: 'dealer', active: true },
          }} />
        ) },
        { id: 'markets', label: T('masters.tabs.markets'), render: () => (
          <CrudTable config={{
            table: 'market', order: 'code',
            columns: [{ key: 'code', type: 'mono' }, { key: 'name' }, { key: 'transit_days', type: 'int' }, { key: 'label_language' }, { key: 'is_domestic', type: 'bool' }],
            fields: [{ key: 'code', required: true }, { key: 'name', required: true }, { key: 'transit_days', type: 'int', required: true, min: 0 }, { key: 'label_language', required: true }, { key: 'is_domestic', type: 'bool' }],
            defaults: { transit_days: 0, label_language: 'tr' },
          }} />
        ) },
        { id: 'lanes', label: T('masters.tabs.lanes'), render: () => (
          <CrudTable config={{
            table: 'supplier_lane', order: 'created_at', lookups: ['party', 'family', 'item'],
            columns: [{ key: 'supplier_id', label: T('supply.supplier'), lookup: 'party' }, { key: 'item_family_id', label: T('plan.family'), lookup: 'family' }, { key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'production_line' }, { key: 'mode', type: 'badge' }, { key: 'quoted_lt_days', type: 'num' }, { key: 'moq', type: 'num' }, { key: 'order_multiple', type: 'num' }, { key: 'price_breaks', type: 'json' }, { key: 'review_days', type: 'int' }, { key: 'active', type: 'bool' }],
            fields: [
              { key: 'supplier_id', label: T('supply.supplier'), type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'supplier' }, { key: 'production_line', hint: T('masters.laneHint') },
              { key: 'item_family_id', label: T('plan.family'), type: 'lookup', lookup: 'family' }, { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item' },
              { key: 'mode', type: 'select', options: ['road', 'sea', 'air', 'rail', 'production'], required: true }, { key: 'quoted_lt_days', type: 'number', required: true, min: 0 }, { key: 'moq', type: 'number', min: 0 }, { key: 'order_multiple', type: 'number', min: 0 },
              { key: 'review_days', type: 'int', min: 1 }, { key: 'price_breaks', type: 'json', hint: '[{"min_qty":5000,"discount_pct":0}]' }, { key: 'active', type: 'bool' },
            ],
            defaults: { mode: 'road', active: true, price_breaks: [] },
            prepare: (d) => ({ ...d, price_breaks: d.price_breaks ?? [] }),
          }} />
        ) },
        { id: 'vehicles', label: T('masters.tabs.vehicles'), render: () => (
          <CrudTable config={{
            table: 'vehicle_type', order: 'code',
            columns: [{ key: 'code', type: 'mono' }, { key: 'name' }, { key: 'min_kg', type: 'num' }, { key: 'max_kg', type: 'num' }, { key: 'max_items', type: 'int' }, { key: 'positions', type: 'json' }, { key: 'is_default', type: 'bool' }],
            fields: [{ key: 'code', required: true }, { key: 'name' }, { key: 'min_kg', type: 'number', required: true, min: 0 }, { key: 'max_kg', type: 'number', required: true, min: 0 }, { key: 'max_items', type: 'int', min: 1 }, { key: 'positions', type: 'json' }, { key: 'is_default', type: 'bool' }],
            defaults: { positions: {} },
            prepare: (d) => ({ ...d, positions: d.positions ?? {} }),
          }} />
        ) },
        { id: 'users', label: T('masters.tabs.users'), render: () => <Users /> },
      ]}
    />
  );
}
