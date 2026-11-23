/**
 * Three-step scan confirmation (spec section 5): every stock action is
 * confirmed by source, pallet and destination scans. Pure state machine; the
 * <ScanFlow> component adds tones, the banner and server-side checks.
 */
import type { ClassifiedScan, ScanKind } from '@dayson/domain';
import type { MessageKey } from '@/i18n';

export type ScanMethod = 'scan' | 'manual';

export interface ScanMeta {
  method: ScanMethod;
  /** Mandatory for manual entry. */
  reason_code?: string;
}

export interface ScanStep {
  key: string;
  label: MessageKey;
  accepts: readonly ScanKind[];
}

export interface StepValue {
  scan: ClassifiedScan;
  method: ScanMethod;
  reason_code?: string;
  scanned_at: string;
}

export interface FlowRefusal {
  reason: 'unknown' | 'wrong_kind' | 'rejected';
  message: MessageKey;
  /** wrong_kind: label keys of what was expected and what was scanned. */
  expected?: MessageKey;
  got?: MessageKey;
  /** Free text from a server check, shown as is. */
  detail?: string;
}

export interface FlowState {
  index: number;
  values: Record<string, StepValue>;
  refusal: FlowRefusal | null;
  done: boolean;
}

export const SOURCE_PALLET_DESTINATION: readonly ScanStep[] = [
  { key: 'source', label: 'flow.source', accepts: ['location'] },
  { key: 'pallet', label: 'flow.pallet', accepts: ['pallet_serial', 'gs1'] },
  { key: 'destination', label: 'flow.destination', accepts: ['location'] },
];

export const KIND_LABEL: Record<ScanKind, MessageKey> = {
  location: 'scan.kind.location',
  gs1: 'scan.kind.gs1',
  pallet_serial: 'scan.kind.pallet_serial',
  unknown: 'scan.kind.unknown',
};

export function initialFlowState(): FlowState {
  return { index: 0, values: {}, refusal: null, done: false };
}

export type FlowCheck = { ok: true } | { ok: false; refusal: FlowRefusal };

/** Does this scan fit the step that is currently expected? */
export function checkScan(steps: readonly ScanStep[], state: FlowState, scan: ClassifiedScan): FlowCheck {
  if (state.done) return { ok: false, refusal: { reason: 'rejected', message: 'scan.refused.rejected' } };
  const step = steps[state.index];
  if (scan.kind === 'unknown') {
    return { ok: false, refusal: { reason: 'unknown', message: 'scan.refused.unknown' } };
  }
  if (!step.accepts.includes(scan.kind)) {
    return {
      ok: false,
      refusal: { reason: 'wrong_kind', message: 'scan.refused.wrongKind', expected: step.label, got: KIND_LABEL[scan.kind] },
    };
  }
  return { ok: true };
}

/** Record an accepted scan and move to the next step. */
export function acceptScan(
  steps: readonly ScanStep[],
  state: FlowState,
  scan: ClassifiedScan,
  meta: ScanMeta,
  scannedAt: string,
): FlowState {
  const step = steps[state.index];
  const values = {
    ...state.values,
    [step.key]: { scan, method: meta.method, reason_code: meta.reason_code, scanned_at: scannedAt },
  };
  const index = state.index + 1;
  return { index, values, refusal: null, done: index >= steps.length };
}

export function refuseScan(state: FlowState, refusal: FlowRefusal): FlowState {
  return { ...state, refusal };
}

/** "manual" when any confirmation was typed; it then counts against scan compliance. */
export function flowScanMethod(values: Record<string, StepValue>): ScanMethod {
  return Object.values(values).some((v) => v.method === 'manual') ? 'manual' : 'scan';
}
