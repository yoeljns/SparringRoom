'use client';

import { useState } from 'react';
import { rows, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from '../DataTable';
import { useLoad } from '../hooks';
import { fDateTime, T } from '../i18n';
import { useLookups, withLookups } from '../lookups';
import { Drawer, Facts, Field, Select, StatusBadge, inputCls } from '../ui';

const TABLES = [
  'item', 'item_family', 'party', 'location', 'lot', 'market', 'supplier_lane', 'vehicle_type', 'uom_pack', 'pack_config', 'planning_param', 'param_override',
  'sales_order', 'so_line', 'shipment', 'reservation', 'campaign', 'campaign_scope', 'campaign_mechanic', 'purchase_order', 'po_line', 'production_order', 'app_user', 'approval_request', 'bundle', 'bundle_line',
];

/** Field-by-field difference between the old and the new row. */
export function diffRows(oldRow: Row | null, newRow: Row | null): { key: string; before: unknown; after: unknown }[] {
  const keys = new Set([...Object.keys(oldRow ?? {}), ...Object.keys(newRow ?? {})]);
  const out: { key: string; before: unknown; after: unknown }[] = [];
  for (const key of [...keys].sort()) {
    if (key === 'updated_at') continue;
    const before = oldRow?.[key];
    const after = newRow?.[key];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) out.push({ key, before, after });
  }
  return out;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function AuditScreen() {
  const lk = useLookups(['user']);
  const [table, setTable] = useState('');
  const [action, setAction] = useState('');
  const [rowId, setRowId] = useState('');
  const [from, setFrom] = useState('');
  const validId = /^[0-9a-f-]{36}$/i.test(rowId.trim());
  const list = useLoad(
    () => rows('audit_log', (q) => {
      if (table) q = q.eq('table_name', table);
      if (action) q = q.eq('action', action);
      if (validId) q = q.eq('row_id', rowId.trim());
      if (from) q = q.gte('at', `${from}T00:00:00+03:00`);
      return q.order('at', { ascending: false }).limit(500);
    }),
    [table, action, validId ? rowId.trim() : '', from],
  );
  const [open, setOpen] = useState<Row | null>(null);
  const diff = open ? diffRows(open.old, open.new) : [];
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('audit.help')}</p>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label={T('audit.table')}><Select value={table} onChange={setTable} placeholder={T('c.all')} options={TABLES.map((x) => ({ value: x, label: x }))} /></Field>
        <Field label={T('audit.action')}><Select value={action} onChange={setAction} placeholder={T('c.all')} options={['INSERT', 'UPDATE', 'DELETE'].map((x) => ({ value: x, label: T(`audit.act.${x}`) }))} /></Field>
        <Field label={T('audit.rowId')}><input className={inputCls} value={rowId} onChange={(e) => setRowId(e.target.value)} placeholder="uuid" /></Field>
        <Field label={T('audit.from')}><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      </div>
      <DataTable
        testId="audit-rows"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        onRowClick={setOpen}
        columns={withLookups([
          { key: 'at', type: 'datetime' }, { key: 'table_name', type: 'mono' }, { key: 'action', render: (r) => <StatusBadge value={T(`audit.act.${r.action}`)} />, text: (r) => r.action },
          { key: 'row_id', type: 'mono', render: (r) => <code className="text-xs">{String(r.row_id ?? '').slice(0, 8)}</code> },
          { key: 'user_id', lookup: 'user' } as Column,
          { key: 'changed', label: T('audit.changed'), render: (r) => diffRows(r.old, r.new).map((d) => d.key).slice(0, 6).join(', ') || '—', text: (r) => diffRows(r.old, r.new).map((d) => d.key).join(' ') },
        ], lk)}
      />
      {open ? (
        <Drawer wide title={`${open.table_name} · ${T(`audit.act.${open.action}`)}`} onClose={() => setOpen(null)}>
          <Facts items={[[T('audit.time'), fDateTime(open.at)], [T('audit.user'), lk.label('user', open.user_id)], [T('audit.rowId'), <code key="r" className="text-xs">{open.row_id}</code>]]} />
          <table className="w-full text-sm" data-testid="audit-diff">
            <thead><tr className="border-b border-line text-left text-xs uppercase text-muted"><th className="py-1 pr-3">{T('audit.field')}</th><th className="py-1 pr-3">{T('audit.old')}</th><th className="py-1">{T('audit.new')}</th></tr></thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.key} className="border-b border-line align-top">
                  <td className="py-1.5 pr-3 font-mono text-xs">{d.key}</td>
                  <td className="break-all py-1.5 pr-3 text-brand">{show(d.before)}</td>
                  <td className="break-all py-1.5 text-ok">{show(d.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Drawer>
      ) : null}
    </>
  );
}
