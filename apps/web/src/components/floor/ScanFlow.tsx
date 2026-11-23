'use client';

import { useCallback, useRef, useState } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import { t } from '@/i18n';
import type { LogScan } from '@/lib/data/scan-log';
import { errorText } from '@/lib/floor/errors';
import { feedback } from '@/lib/floor/feedback';
import {
  SOURCE_PALLET_DESTINATION,
  acceptScan,
  checkScan,
  initialFlowState,
  refuseScan,
  type FlowRefusal,
  type FlowState,
  type ScanMeta,
  type ScanStep,
  type StepValue,
} from '@/lib/floor/scan-flow';
import { useScanLogger } from '@/lib/floor/use-scan-logger';
import { Icon } from '../icons';
import { ScanInput, describeScan } from './ScanInput';

export type StepValidation = { ok: true } | { ok: false; code?: string; message?: string };

export interface ScanFlowProps {
  /** Defaults to source -> pallet -> destination. */
  steps?: readonly ScanStep[];
  /** Used in the scan log, e.g. "transfer". */
  context: string;
  /**
   * Business check of a scan that has the right class, e.g. "is this the
   * lane the task names?". Return ok: false to refuse it.
   */
  validate?: (step: ScanStep, scan: ClassifiedScan, values: Record<string, StepValue>) => StepValidation | Promise<StepValidation>;
  /** Called once when the last step is accepted. */
  onComplete: (values: Record<string, StepValue>) => void | Promise<void>;
  logScan?: LogScan;
  allowManual?: boolean;
  /** What the task expects at a step (e.g. the lane code), shown under its label. */
  hints?: Record<string, string | undefined>;
  /** Hide the green "done" row when the screen shows its own result. */
  hideDone?: boolean;
}

function refusalText(refusal: FlowRefusal): string {
  if (refusal.detail) return refusal.detail;
  if (refusal.reason === 'wrong_kind' && refusal.expected && refusal.got) {
    return t('scan.refused.wrongKind', { expected: t(refusal.expected), got: t(refusal.got) });
  }
  return t(refusal.message);
}

/**
 * Reusable scan confirmation: shows which scan is expected, checks the class
 * of each scan and refuses the wrong one with a tone and a red banner.
 */
export function ScanFlow({
  steps = SOURCE_PALLET_DESTINATION,
  context,
  validate,
  onComplete,
  logScan,
  allowManual = true,
  hints,
  hideDone = false,
}: ScanFlowProps) {
  const [state, setState] = useState<FlowState>(initialFlowState);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  // The ref is the source of truth for scan handling: two scans can arrive
  // faster than React re-renders. Every change goes through commit().
  const stateRef = useRef(state);
  const busyRef = useRef(false);
  const commit = useCallback((next: FlowState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const log = useScanLogger(logScan, context);

  const refuse = useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, refusal: FlowRefusal, logReason: string) => {
      feedback('refused');
      setShake((n) => n + 1);
      const current = stateRef.current;
      commit(refuseScan(current, refusal));
      log(scan, meta, logReason, steps[current.index]?.key);
    },
    [log, commit, steps],
  );

  const handleScan = useCallback(
    async (scan: ClassifiedScan, meta: ScanMeta) => {
      if (busyRef.current) {
        feedback('refused');
        return;
      }
      const current = stateRef.current;
      const check = checkScan(steps, current, scan);
      if (!check.ok) {
        refuse(scan, meta, check.refusal, check.refusal.reason);
        return;
      }
      const step = steps[current.index];
      if (validate) {
        busyRef.current = true;
        setBusy(true);
        let result: StepValidation;
        try {
          result = await validate(step, scan, current.values);
        } catch (err) {
          result = { ok: false, message: err instanceof Error ? err.message : String(err) };
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
        if (!result.ok) {
          const detail = result.code ? errorText(result.code, result.message) : result.message;
          refuse(scan, meta, { reason: 'rejected', message: 'scan.refused.rejected', detail }, result.code ?? 'rejected');
          return;
        }
      }
      const next = acceptScan(steps, current, scan, meta, new Date().toISOString());
      commit(next);
      feedback('accepted');
      log(scan, meta, 'accepted', step.key);
      if (next.done) await onComplete(next.values);
    },
    [steps, validate, onComplete, refuse, commit, log],
  );

  const restart = () => commit(initialFlowState());

  const current = state.done ? null : steps[state.index];

  return (
    <section className="flex flex-col gap-4" data-testid="scan-flow">
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => {
          const value = state.values[step.key];
          const isCurrent = !state.done && i === state.index;
          return (
            <li
              key={step.key}
              aria-current={isCurrent ? 'step' : undefined}
              data-state={value ? 'done' : isCurrent ? 'current' : 'pending'}
              className={`flex min-h-16 items-center gap-3 rounded-xl border-2 px-3 py-2 ${
                isCurrent ? 'border-ink bg-ink text-paper' : value ? 'border-line bg-surface text-ink' : 'border-line bg-paper text-muted'
              }`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-extrabold ${
                  value ? 'bg-ok text-paper' : isCurrent ? 'bg-brand text-paper' : 'bg-surface text-muted'
                }`}
              >
                {value ? <Icon name="check" size={22} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold leading-tight">{t(step.label)}</span>
                {value ? (
                  <span className="block truncate font-mono text-base">
                    {describeScan(value.scan)}
                    {value.method === 'manual' ? ` (${t('scan.method.manual')})` : ''}
                  </span>
                ) : hints?.[step.key] ? (
                  <span className="block truncate font-mono text-base font-semibold opacity-90">{hints[step.key]}</span>
                ) : isCurrent ? (
                  <span className="block text-sm font-medium opacity-80">{t('scan.waiting')}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {state.refusal ? (
        <div
          key={shake}
          role="alert"
          data-testid="refusal-banner"
          className="animate-refused flex items-center gap-3 rounded-xl bg-brand px-4 py-3 text-lg font-bold text-paper"
        >
          <Icon name="x" size={28} className="shrink-0" />
          <span>{refusalText(state.refusal)}</span>
        </div>
      ) : null}

      {state.done ? (
        hideDone ? null : <div role="status" className="flex items-center gap-3 rounded-xl bg-ok-soft px-4 py-3 text-lg font-bold text-ok">
          <Icon name="check" size={28} />
          {t('flow.done')}
        </div>
      ) : (
        <ScanInput
          onScan={(scan, meta) => void handleScan(scan, meta)}
          disabled={busy}
          allowManual={allowManual}
          prompt={current ? t('flow.expecting', { what: t(current.label) }) : undefined}
        />
      )}

      {!state.done && (state.index > 0 || state.refusal) ? (
        <button
          type="button"
          onClick={restart}
          className="min-h-14 rounded-xl border-2 border-line-strong bg-paper px-4 text-lg font-semibold text-ink active:bg-surface"
        >
          {t('flow.restart')}
        </button>
      ) : null}
    </section>
  );
}
