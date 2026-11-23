/**
 * Unrecognised and refused scans are logged (spec section 6, "Scan parsing").
 * WIRING: set SCAN_LOG_RPC and the argument names when the lead sends the
 * RPC list. Until then logging is a no-op so nothing lands in the outbox's
 * rejected list.
 */
import type { ScanKind } from '@dayson/domain';
import type { OutboxApi } from '@/lib/floor/outbox/types';

export const SCAN_LOG_RPC: string | null = null;

export interface ScanLogEntry {
  raw: string;
  kind: ScanKind;
  /** Screen or flow step where the scan happened, e.g. "transfer.pallet". */
  context: string;
  /** Why it was refused: "unknown", "wrong_kind", or a business code. */
  reason: string;
  method: 'scan' | 'manual';
  scanned_at: string;
}

export type LogScan = (entry: ScanLogEntry) => void | Promise<void>;

/** Default logger for the floor: queued through the outbox so it survives offline. */
export function createScanLogger(outbox: Pick<OutboxApi, 'enqueue'>): LogScan {
  return async (entry) => {
    if (!SCAN_LOG_RPC) return;
    await outbox.enqueue(SCAN_LOG_RPC, (meta) => ({ p_entry: { ...entry, client_uuid: meta.client_uuid } }), {
      event_at: entry.scanned_at,
    });
  };
}
