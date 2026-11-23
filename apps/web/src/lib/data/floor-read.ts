/**
 * Online reads of the floor app: task lists, queues and lookups.
 * Only plain column selects on tables / views and rpc calls are used (no
 * embedded resources), so the same code runs against PostgREST and the local
 * development gateway. Joins are done here in the client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PutawaySuggestion, TruckStatus } from './floor-cmd';
import { callRpc } from './rpc';

/** A failed read. `transient` is true when the server could not be reached. */
export class FloorReadError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FloorReadError';
  }
}

type Query<T> = PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null; status: number }>;

async function rows<T>(query: Query<T>): Promise<T[]> {
  let result: Awaited<Query<T>>;
  try {
    result = await query;
  } catch (err) {
    throw new FloorReadError(err instanceof Error ? err.message : String(err), true);
  }
  if (result.error) {
    const status = result.status ?? 0;
    throw new FloorReadError(result.error.message, status === 0 || status >= 500 || status === 401, result.error.code);
  }
  return result.data ?? [];
}

async function rpc<T>(sb: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const out = await callRpc<T>(sb, name, args);
  if (out.ok) return out.data;
  throw new FloorReadError(out.message, out.kind === 'transient', out.kind === 'business' ? out.code : undefined);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  type: string;
  priority: number;
  state: string;
  assigned_to: string | null;
  assigned_role: string | null;
  shipment_id: string | null;
  shipment_no: string | null;
  reservation_id: string | null;
  location_id: string | null;
  location_code: string | null;
  to_location_id: string | null;
  to_location_code: string | null;
  item_id: string | null;
  sku: string | null;
  item_name: string | null;
  lot_id: string | null;
  lot_no: string | null;
  expiry_date: string | null;
  pallet_id: string | null;
  pallet_serial: string | null;
  party_id: string | null;
  party_name: string | null;
  qty_base: number | null;
  pallets: number | null;
  payload: Record<string, unknown> | null;
  due_at: string | null;
  created_at: string;
}

export function listTasks(sb: SupabaseClient, type?: string): Promise<TaskRow[]> {
  let q = sb.from('v_task').select('*');
  if (type) q = q.eq('type', type);
  return rows<TaskRow>(q.order('priority').order('created_at').limit(500));
}

export interface CountTaskRow {
  id: string;
  location_id: string;
  location_code: string;
  location_type: string;
  item_id: string | null;
  sku: string | null;
  item_name: string | null;
  lot_id: string | null;
  lot_no: string | null;
  trigger: string;
  state: 'open' | 'recount';
  assigned_to: string | null;
  counted_by: string | null;
  created_at: string;
}

/** Blind count tasks: the view never exposes the expected quantity. */
export function listCountTasks(sb: SupabaseClient): Promise<CountTaskRow[]> {
  return rows<CountTaskRow>(sb.from('v_count_task_blind').select('*').order('created_at').limit(300));
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

export interface ItemRow {
  id: string;
  sku: string;
  name: string;
  gtin: string | null;
  base_uom: string;
  lot_expiry_controlled: boolean;
}

export function listItems(sb: SupabaseClient): Promise<ItemRow[]> {
  return rows<ItemRow>(sb.from('item').select('id,sku,name,gtin,base_uom,lot_expiry_controlled').order('sku').limit(2000));
}

export interface LocationRow {
  id: string;
  code: string;
  type: string;
  dealer_id: string | null;
}

export function listLocations(sb: SupabaseClient): Promise<LocationRow[]> {
  return rows<LocationRow>(sb.from('location').select('id,code,type,dealer_id').neq('type', 'virtual').order('code').limit(5000));
}

export interface PartyRow {
  id: string;
  name: string;
  type: string;
  consignment: boolean;
}

export async function listParties(sb: SupabaseClient, types: string[]): Promise<PartyRow[]> {
  return rows<PartyRow>(sb.from('party').select('id,name,type,consignment').in('type', types).eq('active', true).order('name').limit(2000));
}

/** Dealers a sales rep may act for (rep_dealer); other roles get every dealer. */
export async function listDealersFor(sb: SupabaseClient, userId: string | null, role: string | null): Promise<PartyRow[]> {
  const parties = await listParties(sb, ['dealer', 'importer']);
  if (role !== 'sales_rep' || !userId) return parties;
  const mine = await rows<{ party_id: string }>(sb.from('rep_dealer').select('party_id').eq('user_id', userId).limit(2000));
  const allowed = new Set(mine.map((r) => r.party_id));
  return parties.filter((p) => allowed.has(p.id));
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export interface ReceiveDoc {
  doc_type: 'po_line' | 'production_order';
  doc_id: string;
  doc_no: string;
  line_no: number | null;
  partner: string | null;
  item_id: string;
  sku: string;
  item_name: string;
  gtin: string | null;
  base_uom: string;
  lot_controlled: boolean;
  qty: number;
  received_qty: number;
  /** Base units on one pallet (uom_pack level pallet), when defined. */
  units_per_pallet: number | null;
}

interface PoRow {
  id: string;
  po_no: string;
  supplier_id: string;
  state: string;
}
interface PoLineRow {
  id: string;
  po_id: string;
  line_no: number;
  item_id: string;
  qty: number;
  received_qty: number;
  state: string;
}
interface ProductionRow {
  id: string;
  order_no: string;
  item_id: string;
  qty: number;
  received_qty: number;
  line: string | null;
  state: string;
}

/** Open documents that can be received against: purchase order lines and production orders. */
export async function listReceiveDocs(sb: SupabaseClient): Promise<ReceiveDoc[]> {
  const [pos, lines, production, items, packs, suppliers] = await Promise.all([
    rows<PoRow>(sb.from('purchase_order').select('id,po_no,supplier_id,state').in('state', ['ordered', 'confirmed', 'partially_received']).limit(1000)),
    rows<PoLineRow>(
      sb.from('po_line').select('id,po_id,line_no,item_id,qty,received_qty,state').in('state', ['open', 'partially_received']).limit(5000),
    ),
    rows<ProductionRow>(
      sb.from('production_order').select('id,order_no,item_id,qty,received_qty,line,state').in('state', ['planned', 'in_progress']).limit(1000),
    ),
    listItems(sb),
    rows<{ item_id: string; qty_base: number }>(sb.from('uom_pack').select('item_id,qty_base').eq('level', 'pallet').limit(5000)),
    listParties(sb, ['supplier']).catch(() => [] as PartyRow[]),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const poById = new Map(pos.map((p) => [p.id, p]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s.name]));
  const palletQty = new Map(packs.map((p) => [p.item_id, Number(p.qty_base)]));
  const docs: ReceiveDoc[] = [];
  const base = (itemId: string) => {
    const item = itemById.get(itemId);
    return {
      item_id: itemId,
      sku: item?.sku ?? '?',
      item_name: item?.name ?? '',
      gtin: item?.gtin ?? null,
      base_uom: item?.base_uom ?? 'piece',
      lot_controlled: item?.lot_expiry_controlled ?? true,
      units_per_pallet: palletQty.get(itemId) ?? null,
    };
  };
  for (const line of lines) {
    const po = poById.get(line.po_id);
    if (!po) continue;
    docs.push({
      doc_type: 'po_line',
      doc_id: line.id,
      doc_no: po.po_no,
      line_no: line.line_no,
      partner: supplierById.get(po.supplier_id) ?? null,
      qty: Number(line.qty),
      received_qty: Number(line.received_qty),
      ...base(line.item_id),
    });
  }
  for (const pr of production) {
    docs.push({
      doc_type: 'production_order',
      doc_id: pr.id,
      doc_no: pr.order_no,
      line_no: null,
      partner: pr.line,
      qty: Number(pr.qty),
      received_qty: Number(pr.received_qty),
      ...base(pr.item_id),
    });
  }
  return docs.sort((a, b) => a.doc_no.localeCompare(b.doc_no) || (a.line_no ?? 0) - (b.line_no ?? 0));
}

export interface LotRow {
  id: string;
  item_id: string;
  lot_no: string;
  prod_date: string | null;
  expiry_date: string | null;
  actual_pallet_kg: number | null;
}

/** The lot with this number, or null when it does not exist yet. */
export async function findLot(sb: SupabaseClient, itemId: string, lotNo: string): Promise<LotRow | null> {
  const found = await rows<LotRow>(
    sb.from('lot').select('id,item_id,lot_no,prod_date,expiry_date,actual_pallet_kg').eq('item_id', itemId).eq('lot_no', lotNo).limit(1),
  );
  return found[0] ?? null;
}

// ---------------------------------------------------------------------------
// QC, shipping, stock
// ---------------------------------------------------------------------------

export interface QcRow {
  lot_id: string;
  lot_no: string;
  item_id: string;
  sku: string;
  item_name: string;
  expiry_date: string | null;
  stock_status: 'quarantine' | 'blocked_expiry';
  qty_base: number;
  age_hours: number;
  locations: string | null;
}

export function listQcQueue(sb: SupabaseClient): Promise<QcRow[]> {
  return rows<QcRow>(sb.from('v_qc_queue').select('*').order('age_hours', { ascending: false }).limit(500));
}

export interface ShipmentRow {
  id: string;
  shipment_no: string;
  party_id: string | null;
  party_name: string | null;
  planned_date: string | null;
  state: string;
  e_irsaliye_no: string | null;
  seal_no: string | null;
  pallets_picked: number;
  pallets_loaded: number;
  qty_to_pick: number;
}

export function listShipments(sb: SupabaseClient, states: string[]): Promise<ShipmentRow[]> {
  return rows<ShipmentRow>(
    sb
      .from('v_shipment')
      .select('id,shipment_no,party_id,party_name,planned_date,state,e_irsaliye_no,seal_no,pallets_picked,pallets_loaded,qty_to_pick')
      .in('state', states)
      .order('planned_date')
      .limit(300),
  );
}

export function truckStatus(sb: SupabaseClient, shipmentId: string): Promise<TruckStatus> {
  return rpc<TruckStatus>(sb, 'rpc_truck_status', { p_shipment: shipmentId });
}

export interface StockRow {
  item_id: string;
  sku: string;
  item_name: string;
  lot_id: string | null;
  lot_no: string | null;
  expiry_date: string | null;
  band: string | null;
  qc_status: string | null;
  location_id: string;
  location_code: string;
  location_type: string;
  stock_status: string;
  qty_base: number;
  pallets: number | null;
}

export function stockAtLocation(sb: SupabaseClient, locationId: string): Promise<StockRow[]> {
  return rows<StockRow>(sb.from('v_stock').select('*').eq('location_id', locationId).order('sku').limit(500));
}

export interface ConsolidationRow {
  item_id: string;
  lot_id: string | null;
  sku: string;
  lot_no: string | null;
  from_location_id: string;
  from_code: string;
  from_pallets: number;
  to_location_id: string;
  to_code: string;
  to_pallets: number;
}

export function listConsolidation(sb: SupabaseClient): Promise<ConsolidationRow[]> {
  return rows<ConsolidationRow>(sb.from('v_consolidation').select('*').order('from_code').limit(200));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export interface LookupPallet {
  id: string;
  serial: string;
  item_id: string;
  lot_id: string | null;
  qty_base: number;
  status: string;
  location_id: string | null;
  shipment_id: string | null;
  loaded_at: string | null;
  sku: string;
  name: string;
  gtin: string | null;
  lot_no: string | null;
  prod_date: string | null;
  expiry_date: string | null;
  base_uom?: string;
  kg: number | null;
}

export type ScanLookup =
  | {
      kind: 'pallet';
      pallet: LookupPallet;
      location: string | null;
      stock_status: string | null;
      lot: { qc_status?: string; band?: string | null; actual_pallet_kg?: number | null } | null;
      putaway: PutawaySuggestion | null;
    }
  | {
      kind: 'location';
      location: { id: string; code: string; type: string; zone: string | null; depth_positions: number | null; max_stack_height: number | null };
      stock: StockRow[];
      pallets: { serial: string; qty_base: number }[];
    }
  | { kind: 'item'; item: ItemRow; stock: StockRow[] }
  | { kind: 'unknown' };

/** Sorgu: what is this code and where is it. */
export function scanLookup(sb: SupabaseClient, args: { code?: string | null; gtin?: string | null; lot_no?: string | null }): Promise<ScanLookup> {
  return rpc<ScanLookup>(sb, 'rpc_scan_lookup', { p_code: args.code ?? null, p_gtin: args.gtin ?? null, p_lot_no: args.lot_no ?? null });
}

export function putawaySuggestion(sb: SupabaseClient, serial: string): Promise<PutawaySuggestion | null> {
  return rpc<PutawaySuggestion | null>(sb, 'rpc_putaway_suggestion', { p_pallet_serial: serial });
}

// ---------------------------------------------------------------------------
// Approvals (second-person confirmation)
// ---------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  type: string;
  state: 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled';
  reason: string | null;
  decision_note: string | null;
  entity_id: string | null;
  created_at: string;
}

const APPROVAL_COLS = 'id,type,state,reason,decision_note,entity_id,created_at';

/** Latest weight-override request of a truck, or null. */
export async function weightOverrideOf(sb: SupabaseClient, shipmentId: string): Promise<ApprovalRow | null> {
  const found = await rows<ApprovalRow>(
    sb
      .from('approval_request')
      .select(APPROVAL_COLS)
      .eq('type', 'weight_override')
      .eq('entity_id', shipmentId)
      .order('created_at', { ascending: false })
      .limit(1),
  );
  return found[0] ?? null;
}

export async function approvalById(sb: SupabaseClient, id: string): Promise<ApprovalRow | null> {
  const found = await rows<ApprovalRow>(sb.from('approval_request').select(APPROVAL_COLS).eq('id', id).limit(1));
  return found[0] ?? null;
}

/** rpc_request_approval raises on refusal; returns the request id. */
export function requestApproval(sb: SupabaseClient, type: string, payload: Record<string, unknown>, reason: string): Promise<string> {
  return rpc<string>(sb, 'rpc_request_approval', { p_type: type, p_payload: payload, p_reason: reason });
}

/** A rep opens a consignment count for one of their dealers. */
export function createCountTask(sb: SupabaseClient, locationCode: string, trigger: string): Promise<string> {
  return rpc<string>(sb, 'rpc_create_count_task', { p_location: locationCode, p_trigger: trigger });
}
