/**
 * Scan log (spec section 6): every confirmation and every refused or
 * unrecognised scan is written to scan_event through rpc_log_scans.
 * Events are batched: a few scans become one queued call, and the call waits
 * in the offline outbox like any other command.
 */
import type { ScanKind } from '@dayson/domain';
import type { OutboxApi } from '@/lib/floor/outbox/types';

export const SCAN_LOG_RPC = 'rpc_log_scans';

/** Which of the three confirmations a scan was (scan_event.kind). */
export type ScanStepKind = 'source' | 'pallet' | 'destination' | 'other';

export interface ScanLogEntry {
  raw: string;
  /** Class found by the scan parser (scan_event.parsed_class). */
  kind: ScanKind;
  /** Screen or flow where the scan happened, e.g. "transfer". */
  context: string;
  /** Why it was refused ("unknown", "wrong_kind", a business code) or "accepted". */
  reason: string;
  method: 'scan' | 'manual';
  scanned_at: string;
  /** False for a refused or unrecognised scan. Defaults to false unless reason is "accepted". */
  accepted?: boolean;
  step?: ScanStepKind;
  /** Reason picked for a manual entry. */
  reason_code?: string;
}

export type LogScan = (entry: ScanLogEntry) => void | Promise<void>;

/** Row shape of rpc_log_scans(p_events). */
export interface ScanEventRow {
  at: string;
  screen: string;
  kind: ScanStepKind;
  method: 'scan' | 'manual';
  accepted: boolean;
  raw: string;
  parsed_class: ScanKind;
  reason_code: string | null;
  device_id: string | null;
}

export function toScanEvent(entry: ScanLogEntry, deviceId: string | null): ScanEventRow {
  const accepted = entry.accepted ?? entry.reason === 'accepted';
  return {
    at: entry.scanned_at,
    screen: entry.context,
    kind: entry.step ?? 'other',
    method: entry.method,
    accepted,
    raw: entry.raw.slice(0, 200),
    parsed_class: entry.kind,
    // Manual entry: the reason the operator picked. Refusal: why it was refused.
    reason_code: entry.reason_code ?? (accepted ? null : entry.reason),
    device_id: deviceId,
  };
}

export interface ScanLoggerOptions {
  deviceId?: string | null;
  /** Events wait this long for more scans before they are queued. */
  flushMs?: number;
  maxBatch?: number;
}

export interface ScanLogger {
  log: LogScan;
  /** Queue whatever is buffered now (page hide, end of a task). */
  flush: () => Promise<void>;
}

/** Batching logger; the batch is queued through the outbox so it survives offline. */
export function createScanLogger(outbox: Pick<OutboxApi, 'enqueue'>, options: ScanLoggerOptions = {}): ScanLogger {
  const flushMs = options.flushMs ?? 1500;
  const maxBatch = options.maxBatch ?? 25;
  let buffer: ScanEventRow[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    try {
      await outbox.enqueue(SCAN_LOG_RPC, { p_events: events }, { event_at: events[0].at });
    } catch {
      // The log must never break scanning; keep the events for the next flush.
      buffer = [...events, ...buffer];
    }
  };

  const log: LogScan = (entry) => {
    buffer.push(toScanEvent(entry, options.deviceId ?? null));
    if (buffer.length >= maxBatch) return flush();
    if (!timer) timer = setTimeout(() => void flush(), flushMs);
  };

  return { log, flush };
}
