/**
 * WORKAROUND: rpc_digest currently fails in the database with
 * `malformed array literal: "owner"` (its "approvals_waiting" sub-select
 * compares text with a set of text[]). Until that function is fixed, the same
 * digest object is assembled here from the views and tables rpc_digest reads.
 * Row-level security applies to the caller as usual.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Obj = Record<string, unknown>;

export function isDigestArrayBug(message: string | null | undefined): boolean {
  return /malformed array literal/i.test(message ?? '');
}

function isoDay(offsetDays: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(Date.now() + offsetDays * 86400000));
}

async function list(db: SupabaseClient, table: string, build: (q: ReturnType<SupabaseClient['from']>) => unknown): Promise<Obj[]> {
  const { data, error } = (await build(db.from(table))) as { data: Obj[] | null; error: { message: string } | null };
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

function ratio(rows: Obj[], num: string, den: string): number | null {
  const d = rows.reduce((s, r) => s + Number(r[den] ?? 0), 0);
  return d > 0 ? Math.round((10000 * rows.reduce((s, r) => s + Number(r[num] ?? 0), 0)) / d) / 100 : null;
}

export async function buildDigest(db: SupabaseClient): Promise<Obj> {
  const today = isoDay(0);
  const yesterday = isoDay(-1);
  const weekAgo = isoDay(-7);
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const [ira, scan, recon, plans, alerts, qc, approvals, rules, overrides] = await Promise.all([
    list(db, 'v_ira_daily', (q) => q.select('*').gte('day', weekAgo)),
    list(db, 'v_scan_compliance_daily', (q) => q.select('*').gte('day', weekAgo)),
    list(db, 'v_recon_open', (q) => q.select('class,age_hours')),
    list(db, 'plan_version', (q) => q.select('id').eq('kind', 'plan').eq('state', 'published').order('published_at', { ascending: false }).limit(1)),
    list(db, 'alert', (q) => q.select('rule,payload,created_at,acked_at').in('rule', ['lot_band_amber', 'lot_band_red', 'inbound_late', 'campaign_off_forecast', 'truck_weight_override', 'shipment_no_invoice']).order('created_at', { ascending: false }).limit(500)),
    list(db, 'v_qc_queue', (q) => q.select('sku,lot_no,qty_base,stock_status').eq('stock_status', 'blocked_expiry')),
    list(db, 'approval_request', (q) => q.select('id,type,reason,created_at').eq('state', 'pending')),
    list(db, 'approval_rule', (q) => q.select('type,approver_roles')),
    list(db, 'forecast_override', (q) => q.select('source,fva,created_at').gte('created_at', new Date(Date.now() - 92 * 86400000).toISOString()).limit(5000)),
  ]);
  const plan = plans[0]?.id;
  const below = plan
    ? await list(db, 'stock_projection', (q) => q.select('item_id,week,projected_qty,safety_stock').eq('plan_version_id', plan).eq('below_safety', true).lt('week', isoDay(28)).order('week').limit(500))
    : [];
  const items = below.length ? await list(db, 'item', (q) => q.select('id,sku').in('id', [...new Set(below.map((b) => b.item_id))])) : [];
  const sku = new Map(items.map((i) => [i.id, i.sku]));
  const byClass: Record<string, number> = {};
  for (const r of recon) byClass[String(r.class)] = (byClass[String(r.class)] ?? 0) + 1;
  const recent = (a: Obj) => String(a.created_at) > dayAgo;
  const fva = new Map<string, number[]>();
  for (const o of overrides) if (o.fva !== null && o.fva !== undefined) fva.set(String(o.source), [...(fva.get(String(o.source)) ?? []), Number(o.fva)]);
  return {
    date: today,
    accuracy: {
      ira_yesterday: ira.find((r) => r.day === yesterday)?.ira_pct ?? null, ira_7d: ratio(ira, 'within_tolerance', 'counted'),
      scan_yesterday: scan.find((r) => r.day === yesterday)?.compliance_pct ?? null, scan_7d: ratio(scan, 'scanned', 'required'),
    },
    reconciliation: { by_class: byClass, older_than_48h: recon.filter((r) => r.class !== 'timing' && Number(r.age_hours) > 48).length },
    below_safety_4w: below.map((b) => ({ sku: sku.get(b.item_id) ?? b.item_id, week: b.week, projected: b.projected_qty, safety_stock: b.safety_stock })),
    lots_amber_red: alerts.filter((a) => (a.rule === 'lot_band_amber' || a.rule === 'lot_band_red') && recent(a)).map((a) => ({ ...(a.payload as Obj), band: String(a.rule).replace('lot_band_', '') })),
    expiry_blocked_waiting: qc.map((q) => ({ sku: q.sku, lot_no: q.lot_no, qty: q.qty_base })),
    inbound_late: alerts.filter((a) => a.rule === 'inbound_late' && !a.acked_at).map((a) => a.payload),
    campaigns_off_forecast: alerts.filter((a) => a.rule === 'campaign_off_forecast' && recent(a)).map((a) => a.payload),
    weight_overrides: alerts.filter((a) => a.rule === 'truck_weight_override' && recent(a)).map((a) => a.payload),
    shipments_no_invoice: alerts.filter((a) => a.rule === 'shipment_no_invoice' && !a.acked_at).map((a) => a.payload),
    approvals_waiting: approvals.map((a) => ({ ...a, for_owner: ((rules.find((r) => r.type === a.type)?.approver_roles as string[] | undefined) ?? []).includes('owner') })),
    negative_fva_sources: [...fva.entries()].map(([source, v]) => ({ source, fva: Math.round((10000 * v.reduce((s, x) => s + x, 0)) / v.length) / 10000 })).filter((x) => x.fva < 0),
    assembled_by: 'web-fallback',
  };
}

/** rpc_digest, or the fallback when the known database bug is hit. */
export async function loadDigest(db: SupabaseClient): Promise<{ data: Obj | null; error: string | null; fallback: boolean }> {
  const { data, error } = await db.rpc('rpc_digest');
  if (!error) return { data: data as Obj, error: null, fallback: false };
  if (!isDigestArrayBug(error.message)) return { data: null, error: error.message, fallback: false };
  try {
    return { data: await buildDigest(db), error: null, fallback: true };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err), fallback: true };
  }
}
