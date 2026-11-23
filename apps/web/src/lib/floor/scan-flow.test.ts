import { describe, expect, it } from 'vitest';
import { classifyScan } from '@dayson/domain';
import { SOURCE_PALLET_DESTINATION, acceptScan, checkScan, flowScanMethod, initialFlowState, refuseScan } from './scan-flow';

const steps = SOURCE_PALLET_DESTINATION;
const at = '2026-11-23T08:00:00.000Z';

describe('scan flow', () => {
  it('walks source -> pallet -> destination', () => {
    let state = initialFlowState();
    const scans = ['TZ-B03-L12', '086912340000010011', 'TZ-STG-01'].map((raw) => classifyScan(raw));

    expect(checkScan(steps, state, scans[0])).toEqual({ ok: true });
    state = acceptScan(steps, state, scans[0], { method: 'scan' }, at);
    expect(state).toMatchObject({ index: 1, done: false });

    expect(checkScan(steps, state, scans[1])).toEqual({ ok: true });
    state = acceptScan(steps, state, scans[1], { method: 'manual', reason_code: 'label_damaged' }, at);

    expect(checkScan(steps, state, scans[2])).toEqual({ ok: true });
    state = acceptScan(steps, state, scans[2], { method: 'scan' }, at);
    expect(state.done).toBe(true);
    expect(Object.keys(state.values)).toEqual(['source', 'pallet', 'destination']);
    expect(state.values.pallet).toMatchObject({ method: 'manual', reason_code: 'label_damaged', scanned_at: at });
    expect(flowScanMethod(state.values)).toBe('manual');
  });

  it('accepts a GS1 pallet label for the pallet step', () => {
    let state = initialFlowState();
    state = acceptScan(steps, state, classifyScan('TZ-B03-L12'), { method: 'scan' }, at);
    expect(checkScan(steps, state, classifyScan(']d200086912340000010011'))).toEqual({ ok: true });
  });

  it('refuses a scan of the wrong class and stays on the step', () => {
    const state = initialFlowState();
    const check = checkScan(steps, state, classifyScan('086912340000010011'));
    expect(check).toEqual({
      ok: false,
      refusal: { reason: 'wrong_kind', message: 'scan.refused.wrongKind', expected: 'flow.source', got: 'scan.kind.pallet_serial' },
    });
    if (check.ok) throw new Error('unreachable');
    const refused = refuseScan(state, check.refusal);
    expect(refused.index).toBe(0);
    expect(refused.refusal?.reason).toBe('wrong_kind');
    // The next good scan clears the refusal.
    expect(acceptScan(steps, refused, classifyScan('TZ-B03-L12'), { method: 'scan' }, at).refusal).toBeNull();
  });

  it('refuses an unrecognised scan', () => {
    expect(checkScan(steps, initialFlowState(), classifyScan('???'))).toMatchObject({ ok: false, refusal: { reason: 'unknown' } });
  });

  it('refuses a location where a pallet is expected', () => {
    const state = acceptScan(steps, initialFlowState(), classifyScan('TZ-B03-L12'), { method: 'scan' }, at);
    expect(checkScan(steps, state, classifyScan('TZ-B03-L13'))).toMatchObject({ ok: false, refusal: { reason: 'wrong_kind', expected: 'flow.pallet' } });
  });

  it('reports scan when nothing was typed', () => {
    const state = acceptScan(steps, initialFlowState(), classifyScan('TZ-B03-L12'), { method: 'scan' }, at);
    expect(flowScanMethod(state.values)).toBe('scan');
  });
});
