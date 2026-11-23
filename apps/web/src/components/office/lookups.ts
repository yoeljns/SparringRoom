'use client';

import { useEffect, useMemo, useState } from 'react';
import { rows, type Row } from '@/lib/data/office-db';
import type { Column } from './DataTable';
import type { Option } from './ui';

/** Small master lists used for client-side joins and select boxes. */
const DEFS = {
  item: { table: 'item', order: 'sku', label: (r: Row) => `${r.sku} · ${r.name}`, short: (r: Row) => r.sku },
  family: { table: 'item_family', order: 'code', label: (r: Row) => `${r.code} · ${r.name}`, short: (r: Row) => r.code },
  party: { table: 'party', order: 'name', label: (r: Row) => r.name, short: (r: Row) => r.name },
  location: { table: 'location', order: 'code', label: (r: Row) => r.code, short: (r: Row) => r.code },
  market: { table: 'market', order: 'code', label: (r: Row) => `${r.code} · ${r.name}`, short: (r: Row) => r.code },
  user: { table: 'app_user', order: 'full_name', label: (r: Row) => r.full_name || r.email, short: (r: Row) => r.full_name || r.email },
  vehicle_type: { table: 'vehicle_type', order: 'code', label: (r: Row) => `${r.code} · ${r.name ?? ''}`, short: (r: Row) => r.code },
  supplier_lane: { table: 'supplier_lane', order: 'mode', label: (r: Row) => `${r.mode} · ${r.quoted_lt_days} gün`, short: (r: Row) => r.mode },
  bundle: { table: 'bundle', order: 'name', label: (r: Row) => r.name ?? r.id, short: (r: Row) => r.name ?? r.id },
  lot: { table: 'lot', order: 'lot_no', label: (r: Row) => r.lot_no, short: (r: Row) => r.lot_no },
  plan_version: { table: 'plan_version', order: 'created_at', label: (r: Row) => r.name, short: (r: Row) => r.name },
  campaign: { table: 'campaign', order: 'code', label: (r: Row) => `${r.code} · ${r.name}`, short: (r: Row) => r.code },
  purchase_order: { table: 'purchase_order', order: 'po_no', label: (r: Row) => r.po_no, short: (r: Row) => r.po_no },
  po_line: { table: 'po_line', order: 'line_no', label: (r: Row) => `#${r.line_no} · ${r.qty}`, short: (r: Row) => `#${r.line_no}` },
  inbound_shipment: { table: 'inbound_shipment', order: 'eta', label: (r: Row) => `${r.vehicle_ref ?? ''} ${r.eta ?? ''}`, short: (r: Row) => r.vehicle_ref ?? r.id },
  site: { table: 'site', order: 'code', label: (r: Row) => r.code, short: (r: Row) => r.code },
  mechanic_type: { table: 'mechanic_type', order: 'code', label: (r: Row) => r.code, short: (r: Row) => r.code },
} as const;

export type LookupName = keyof typeof DEFS;

const cache = new Map<LookupName, Promise<Row[]>>();

function load(name: LookupName): Promise<Row[]> {
  let p = cache.get(name);
  if (!p) {
    const def = DEFS[name];
    p = rows(def.table, (q) => q.order(def.order).limit(5000)).catch((err) => {
      cache.delete(name);
      throw err;
    });
    cache.set(name, p);
  }
  return p;
}

/** Drop cached lists after a write to their table. */
export function invalidateLookup(table: string): void {
  for (const [name, def] of Object.entries(DEFS)) {
    if (def.table === table) cache.delete(name as LookupName);
  }
}

export interface Lookups {
  ready: boolean;
  list: (name: LookupName) => Row[];
  get: (name: LookupName, id: unknown) => Row | undefined;
  /** Short label (code / name) for an id; the id itself when unknown. */
  label: (name: LookupName, id: unknown) => string;
  options: (name: LookupName, filter?: (r: Row) => boolean) => Option[];
}

export function useLookups(names: readonly LookupName[], version = 0): Lookups {
  const key = names.join(',');
  const [state, setState] = useState<{ key: string; data: Partial<Record<LookupName, Row[]>> }>({ key: '', data: {} });
  useEffect(() => {
    let cancelled = false;
    const list = key ? (key.split(',') as LookupName[]) : [];
    Promise.all(list.map((n) => load(n).catch(() => [] as Row[]))).then((results) => {
      if (cancelled) return;
      const data: Partial<Record<LookupName, Row[]>> = {};
      list.forEach((n, i) => { data[n] = results[i]; });
      setState({ key: `${key}#${version}`, data });
    });
    return () => { cancelled = true; };
  }, [key, version]);

  return useMemo(() => {
    const maps = new Map<LookupName, Map<string, Row>>();
    for (const [n, list] of Object.entries(state.data)) maps.set(n as LookupName, new Map((list ?? []).map((r) => [String(r.id), r])));
    const get = (name: LookupName, id: unknown) => (id === null || id === undefined ? undefined : maps.get(name)?.get(String(id)));
    return {
      ready: state.key === `${key}#${version}`,
      list: (name) => state.data[name] ?? [],
      get,
      label: (name, id) => {
        if (id === null || id === undefined || id === '') return '—';
        const r = get(name, id);
        return r ? String(DEFS[name].short(r)) : String(id).slice(0, 8);
      },
      options: (name, filter) => (state.data[name] ?? []).filter((r) => !filter || filter(r)).map((r) => ({ value: String(r.id), label: String(DEFS[name].label(r)) })),
    };
  }, [state, key, version]);
}

/** Columns with `lookup` show the joined label and search / sort by it. */
export function withLookups<R extends Row>(columns: Column<R>[], lk: Lookups): Column<R>[] {
  return columns.map((c) => {
    const name = (c as Column<R> & { lookup?: LookupName }).lookup;
    if (!name || c.render) return c;
    return { ...c, render: (r: R) => lk.label(name, r[c.key]), text: (r: R) => lk.label(name, r[c.key]) };
  });
}

export type LkColumn<R extends Row = Row> = Column<R> & { lookup?: LookupName };
