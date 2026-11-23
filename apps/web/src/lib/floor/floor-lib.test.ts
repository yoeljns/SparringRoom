import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelRequestOf } from '@/components/floor/LabelPrint';
import tr from '@/i18n/tr.json';
import { cleanArgs, submitFloor, type LabelData } from '@/lib/data/floor-cmd';
import { callRpc, returnedRefusal } from '@/lib/data/rpc';
import { createScanLogger, toScanEvent, type ScanLogEntry } from '@/lib/data/scan-log';
import { errorText } from './errors';
import { parseQty } from './format';
import { Outbox } from './outbox/engine';
import type { OutboxCommand, OutboxStore, RejectedCommand } from './outbox/types';
import { manualReasonOf, methodOf } from './use-floor';

function memoryStore(): OutboxStore & { rejected: RejectedCommand[]; queue: OutboxCommand[] } {
  const queue: OutboxCommand[] = [];
  const rejected: RejectedCommand[] = [];
  let seq = 0;
  return {
    queue,
    rejected,
    async add(command) {
      const row = { ...command, seq: ++seq };
      queue.push(row);
      return row;
    },
    async peek() {
      return queue[0] ?? null;
    },
    async update(command) {
      const i = queue.findIndex((c) => c.seq === command.seq);
      if (i >= 0) queue[i] = command;
    },
    async remove(s) {
      const i = queue.findIndex((c) => c.seq === s);
      if (i >= 0) queue.splice(i, 1);
    },
    async reject(command, info) {
      await this.remove(command.seq);
      rejected.push({ ...command, rejected_at: info.rejected_at, error_code: info.code, error_message: info.message, acknowledged_at: null });
    },
    async count() {
      return queue.length;
    },
    async countUnacknowledgedRejected() {
      return rejected.filter((r) => !r.acknowledged_at).length;
    },
    async listQueued() {
      return [...queue];
    },
    async listRejected() {
      return [...rejected];
    },
    async acknowledgeRejected(client_uuid, at) {
      const row = rejected.find((r) => r.client_uuid === client_uuid);
      if (row) row.acknowledged_at = at;
    },
  };
}

const fakeSupabase = (answer: { data?: unknown; error?: { message: string; code?: string } | null; status?: number }) =>
  ({ rpc: vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null, status: answer.status ?? 200 })) }) as unknown as SupabaseClient;

describe('rpc_floor refusals', () => {
  it('treats a returned {error, message} of rpc_floor and post_txn as a business refusal', () => {
    expect(returnedRefusal('rpc_floor', { error: 'LANE_MIXED', message: 'LANE_MIXED: lane holds another lot' })).toEqual({
      ok: false, kind: 'business', code: 'LANE_MIXED', message: 'LANE_MIXED: lane holds another lot',
    });
    expect(returnedRefusal('post_txn', { error: 'UNBALANCED' })).toMatchObject({ kind: 'business', code: 'UNBALANCED', message: 'UNBALANCED' });
    expect(returnedRefusal('rpc_floor', { txn_id: 'x', duplicate: true })).toBeNull();
    // Other functions raise instead; a field called "error" in their data means nothing.
    expect(returnedRefusal('rpc_scan_lookup', { error: 'X' })).toBeNull();
    expect(returnedRefusal('rpc_floor', null)).toBeNull();
  });

  it('callRpc classifies the returned refusal, and a success stays ok', async () => {
    expect(await callRpc(fakeSupabase({ data: { error: 'WEIGHT_REQUIRED', message: 'WEIGHT_REQUIRED: enter kg' } }), 'rpc_floor', {})).toMatchObject({
      ok: false, kind: 'business', code: 'WEIGHT_REQUIRED',
    });
    expect(await callRpc(fakeSupabase({ data: { txn_id: 't1' } }), 'rpc_floor', {})).toEqual({ ok: true, data: { txn_id: 't1' } });
  });

  it('a refused command lands in the rejected list and is never retried; the next command still goes out', async () => {
    const store = memoryStore();
    const answers = [{ data: { error: 'LOT_REFUSED', message: 'LOT_REFUSED: older stock would be skipped (FEFO)' } }, { data: { txn_id: 't2', picked_qty: 900 } }];
    const calls: Record<string, unknown>[] = [];
    const outbox = new Outbox({
      store,
      isOnline: () => true,
      callRpc: (rpc, args) => {
        calls.push(args);
        return callRpc(fakeSupabase(answers[calls.length - 1]), rpc, args);
      },
    });
    const first = await submitFloor(outbox, 'pick', { task_id: 'a', pallet_serial: '086900000000001019', to_location: 'TZ-STG-01', lane: undefined }, { device_id: 'tc-1' });
    const second = await submitFloor(outbox, 'pick', { task_id: 'a', pallet_serial: '086900000000001026', to_location: 'TZ-STG-01' });
    expect(first).toMatchObject({ status: 'rejected', code: 'LOT_REFUSED' });
    expect(second).toMatchObject({ status: 'done', data: { picked_qty: 900 } });
    expect(calls).toHaveLength(2);
    expect(store.rejected.map((r) => r.error_code)).toEqual(['LOT_REFUSED']);
    expect(store.queue).toHaveLength(0);
    // client_uuid and event_at travel inside p_args; empty optionals are dropped.
    const sent = calls[0] as { p_cmd: string; p_args: Record<string, unknown> };
    expect(sent.p_cmd).toBe('pick');
    expect(sent.p_args).toMatchObject({ task_id: 'a', device_id: 'tc-1', client_uuid: store.rejected[0].client_uuid });
    expect(typeof sent.p_args.event_at).toBe('string');
    expect('lane' in sent.p_args).toBe(false);
  });

  it('keeps a command queued while offline and sends it exactly once when the network returns', async () => {
    const store = memoryStore();
    let online = false;
    const send = vi.fn(async () => ({ ok: true as const, data: { txn_id: 't' } }));
    const outbox = new Outbox({ store, isOnline: () => online, callRpc: send });
    const result = await submitFloor(outbox, 'transfer', { pallet_serial: '086900000000001019', from_location: 'TZ-B01-L01', to_location: 'TZ-B03-L03' });
    expect(result.status).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(outbox.getState().queued).toBe(1);
    online = true;
    await outbox.drain();
    await outbox.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.getState().queued).toBe(0);
  });
});

describe('cleanArgs', () => {
  it('drops undefined, null and empty strings but keeps zero and false', () => {
    expect(cleanArgs({ a: 1, b: undefined, c: null, d: '', e: 0, f: false })).toEqual({ a: 1, e: 0, f: false });
  });
});

describe('scan log', () => {
  const entry = (over: Partial<ScanLogEntry> = {}): ScanLogEntry => ({
    raw: 'TZ-B03-L12', kind: 'location', context: 'transfer', reason: 'accepted', method: 'scan', scanned_at: '2026-11-24T08:00:00.000Z', step: 'source', ...over,
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('maps an entry to the rpc_log_scans row', () => {
    expect(toScanEvent(entry(), 'tc-1')).toEqual({
      at: '2026-11-24T08:00:00.000Z', screen: 'transfer', kind: 'source', method: 'scan', accepted: true, raw: 'TZ-B03-L12', parsed_class: 'location', reason_code: null, device_id: 'tc-1',
    });
    expect(toScanEvent(entry({ reason: 'wrong_kind', accepted: false, step: undefined }), null)).toMatchObject({ accepted: false, kind: 'other', reason_code: 'wrong_kind' });
    // Manual entry: the reason the operator picked is what is stored.
    expect(toScanEvent(entry({ method: 'manual', reason_code: 'label_damaged' }), null)).toMatchObject({ method: 'manual', accepted: true, reason_code: 'label_damaged' });
    expect(toScanEvent(entry({ raw: 'x'.repeat(500) }), null).raw).toHaveLength(200);
  });

  it('batches scans into one queued rpc_log_scans call', async () => {
    const enqueue = vi.fn(async () => ({}) as OutboxCommand);
    const logger = createScanLogger({ enqueue }, { deviceId: 'tc-1', flushMs: 1000 });
    void logger.log(entry());
    void logger.log(entry({ raw: '???', kind: 'unknown', reason: 'unknown', accepted: false }));
    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [rpc, args] = enqueue.mock.calls[0] as unknown as [string, { p_events: unknown[] }];
    expect(rpc).toBe('rpc_log_scans');
    expect(args.p_events).toHaveLength(2);
    expect(args.p_events[1]).toMatchObject({ accepted: false, parsed_class: 'unknown', reason_code: 'unknown' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('flushes at once when the batch is full and on demand', async () => {
    const enqueue = vi.fn(async () => ({}) as OutboxCommand);
    const logger = createScanLogger({ enqueue }, { maxBatch: 2, flushMs: 60_000 });
    void logger.log(entry());
    await logger.log(entry());
    expect(enqueue).toHaveBeenCalledTimes(1);
    void logger.log(entry());
    await logger.flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
    await logger.flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('errorText', () => {
  it('uses the Turkish text of a known code and falls back to the server message', () => {
    expect(errorText('LANE_MIXED', 'LANE_MIXED: x')).toBe(tr.errors.LANE_MIXED);
    expect(errorText('WEIGHT_OUT_OF_WINDOW', 'WEIGHT_OUT_OF_WINDOW: truck weighs 905 kg')).toBe(tr.floor.errors.WEIGHT_OUT_OF_WINDOW);
    expect(errorText('SOMETHING_NEW', 'SOMETHING_NEW: explained by the server')).toBe('explained by the server');
    expect(errorText('SOMETHING_NEW', '')).toBe(tr.errors.UNKNOWN);
    expect(errorText(undefined, null)).toBe(tr.errors.UNKNOWN);
  });

  it('has a Turkish text for every refusal code of the API contract', () => {
    const codes = [
      'NOT_PERMITTED', 'INVALID', 'INVALID_STATE', 'NOT_FOUND', 'REASON_REQUIRED', 'APPROVAL_REQUIRED', 'UNBALANCED', 'NEGATIVE_BALANCE', 'LANE_MIXED',
      'LOT_REQUIRED', 'LOT_EXPIRY_MISMATCH', 'MRSL_BLOCKED', 'NOT_AVAILABLE', 'INVALID_LOCATION', 'UNKNOWN_ITEM', 'UNKNOWN_PALLET', 'UNKNOWN_LOCATION',
      'UOM_UNKNOWN', 'WEIGHT_REQUIRED', 'DUPLICATE_PALLET', 'WRONG_ITEM', 'WRONG_LOCATION', 'WRONG_TRUCK', 'LOT_REFUSED', 'PALLET_REQUIRED', 'ALREADY_PICKED',
      'PALLET_UNSCANNED', 'EIRSALIYE_REQUIRED', 'WEIGHT_OUT_OF_WINDOW', 'NOTHING_TO_DO', 'RECOUNT_DIFFERENT_USER',
    ];
    for (const code of codes) expect(errorText(code, `${code}: english detail`), code).not.toBe('english detail');
  });
});

describe('small helpers', () => {
  it('parses typed quantities with a comma or a dot', () => {
    expect(parseQty('12')).toBe(12);
    expect(parseQty(' 12,5 ')).toBe(12.5);
    expect(parseQty('0')).toBe(0);
    expect(parseQty('')).toBeNull();
    expect(parseQty('-3')).toBeNull();
    expect(parseQty('1e3')).toBeNull();
  });

  it('marks a command manual as soon as one confirmation was typed', () => {
    expect(methodOf({ method: 'scan' }, null, undefined)).toBe('scan');
    expect(methodOf({ method: 'scan' }, { method: 'manual', reason_code: 'label_missing' })).toBe('manual');
    expect(manualReasonOf({ method: 'scan' }, { method: 'manual', reason_code: 'label_missing' })).toBe('label_missing');
    expect(manualReasonOf({ method: 'scan' })).toBeUndefined();
  });

  it('builds the label request from the label data returned by rpc_floor', () => {
    const label: LabelData = {
      serial: '086900000000001019', sku: 'DYS-PU-KIRMIZI-SOS', name: 'PU Mastik Kırmızı Sosis 600 ml', gtin: '08690000010110', lot_no: 'R2469510',
      prod_date: '2026-06-12', expiry_date: '2027-06-12', qty_base: 900, kg: 905,
    };
    expect(labelRequestOf({ template: 'pallet', label })).toEqual({
      template: 'pallet', copies: 1,
      data: {
        sscc: '086900000000001019', gtin: '08690000010110', sku: 'DYS-PU-KIRMIZI-SOS', description: 'PU Mastik Kırmızı Sosis 600 ml', lot: 'R2469510',
        expiry: '2027-06-12', production_date: '2026-06-12', pallet_kg: 905,
      },
    });
    expect(labelRequestOf({ template: 'carton', label, copies: 12 })).toEqual({
      template: 'carton', copies: 12, data: { gtin: '08690000010110', sku: 'DYS-PU-KIRMIZI-SOS', lot: 'R2469510', expiry: '2027-06-12' },
    });
    expect(labelRequestOf({ template: 'pallet', label: { ...label, kg: null } })).toBeNull();
    expect(labelRequestOf({ template: 'pallet', label: { ...label, gtin: null } })).toBeNull();
  });
});
