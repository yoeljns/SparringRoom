/**
 * rpc_floor commands (docs/api.md, "Floor"). Every command is queued through
 * the offline outbox with its client_uuid and event_at, so it survives a lost
 * connection and replays in order; the server answers a replayed client_uuid
 * with the first result.
 */
import type { OutboxApi, SubmitResult } from '@/lib/floor/outbox/types';

export const FLOOR_RPC = 'rpc_floor';

export type FloorCmd =
  | 'receive'
  | 'qc'
  | 'putaway'
  | 'transfer'
  | 'pick'
  | 'load'
  | 'close_truck'
  | 'count'
  | 'consignment_consume'
  | 'dealer_observation';

export interface LabelData {
  serial: string;
  sku: string;
  name: string;
  gtin: string | null;
  lot_no: string | null;
  prod_date: string | null;
  expiry_date: string | null;
  qty_base: number;
  base_uom?: string;
  kg: number | null;
}

export interface PutawaySuggestion {
  location: string | null;
  location_id: string | null;
  rule: string;
}

export interface ReceiveResult {
  txn_id: string;
  pallet_id: string;
  pallet_serial: string;
  lot_id: string | null;
  first_pallet_of_lot: boolean;
  label: LabelData;
  putaway: PutawaySuggestion | null;
  duplicate?: boolean;
}

export interface MoveResult {
  txn_id: string;
  to_location: string;
  carton_labels: boolean;
  label: LabelData | null;
}

export interface PickResult {
  txn_id: string;
  picked_qty: number;
  remaining: number;
  reservation_swapped: boolean;
  pallet_id: string;
  label: LabelData | null;
}

export interface TruckPallet {
  serial: string;
  sku: string;
  lot_no: string | null;
  kg: number | null;
  kg_source: string | null;
  loaded: boolean;
}

export interface TruckStatus {
  shipment_id: string;
  loaded_kg: number;
  pallets_loaded: number;
  pallets_total: number;
  min_kg: number;
  max_kg: number;
  to_min_kg: number;
  to_max_kg: number;
  in_window: boolean;
  e_irsaliye_no: string | null;
  unpicked_qty: number;
  pallets: TruckPallet[];
}

export interface CloseTruckResult {
  shipment_id: string;
  state: 'dispatched';
  loaded_kg: string | number;
  in_window: string | boolean;
  weight_override: boolean;
}

export interface CountResult {
  count_task_id: string;
  state: 'closed' | 'recount' | 'pending_approval';
  accepted: boolean;
  adjusted?: boolean;
}

/** Drop undefined, null and empty strings so optional args are simply absent. */
export function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

export interface FloorSubmitOptions {
  /** When the physical event happened (the confirming scan); defaults to now. */
  event_at?: string;
  device_id?: string | null;
  waitMs?: number;
}

/** Queue a floor command and wait briefly for the server's answer. */
export function submitFloor(
  outbox: Pick<OutboxApi, 'submit'>,
  cmd: FloorCmd,
  args: Record<string, unknown>,
  options: FloorSubmitOptions = {},
): Promise<SubmitResult> {
  return outbox.submit(
    FLOOR_RPC,
    (meta) => ({
      p_cmd: cmd,
      p_args: cleanArgs({ ...args, device_id: options.device_id, client_uuid: meta.client_uuid, event_at: meta.event_at }),
    }),
    { event_at: options.event_at, waitMs: options.waitMs },
  );
}
