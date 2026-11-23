/**
 * Typed shape of post_txn(txn jsonb) from spec 4.5.
 * WIRING: confirm field names and the txn_type list against the migration
 * when the lead sends the RPC list.
 */
import type { OutboxApi } from '@/lib/floor/outbox/types';

export type ScanMethod = 'scan' | 'manual';

export interface PostTxnLine {
  item_id: string;
  lot_id: string | null;
  from_location: string | null;
  to_location: string | null;
  from_status?: string;
  to_status?: string;
  qty_entered: number;
  uom: string;
  scan_method: ScanMethod;
}

export interface PostTxnInput {
  client_uuid: string;
  txn_type: string;
  /** ISO timestamp of the physical event (the scan), not of the replay. */
  event_at: string;
  ref_doc_type: string | null;
  ref_doc_id: string | null;
  reason_code?: string;
  campaign_id?: string;
  lines: PostTxnLine[];
}

export interface PostTxnResult {
  txn_id: string;
  moves: unknown[];
  balances_after: unknown[];
}

export const POST_TXN_RPC = 'post_txn';

/** Queue a stock transaction; client_uuid and event_at come from the outbox. */
export function submitPostTxn(outbox: OutboxApi, txn: Omit<PostTxnInput, 'client_uuid' | 'event_at'>) {
  return outbox.submit(POST_TXN_RPC, (meta) => ({ txn: { ...txn, client_uuid: meta.client_uuid, event_at: meta.event_at } }));
}
