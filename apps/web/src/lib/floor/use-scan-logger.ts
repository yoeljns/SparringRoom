'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import type { LogScan, ScanStepKind } from '@/lib/data/scan-log';
import type { ScanMeta } from './scan-flow';

export function stepKindOf(key: string | undefined): ScanStepKind {
  return key === 'source' || key === 'pallet' || key === 'destination' ? key : 'other';
}

/**
 * Returns a function that logs a scan through the injected `logScan`:
 * reason "accepted" for a confirmation, anything else for a refusal.
 * Logging never blocks or breaks the scan screen.
 */
export function useScanLogger(logScan: LogScan | undefined, context: string) {
  const ref = useRef(logScan);
  useEffect(() => {
    ref.current = logScan;
  }, [logScan]);
  return useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, reason: string, step?: string) => {
      const fn = ref.current;
      if (!fn) return;
      try {
        const result = fn({
          raw: scan.raw,
          kind: scan.kind,
          context,
          reason,
          accepted: reason === 'accepted',
          step: stepKindOf(step),
          method: meta.method,
          reason_code: meta.reason_code,
          scanned_at: new Date().toISOString(),
        });
        if (result instanceof Promise) result.catch(() => {});
      } catch {
        // Ignore: the operator has already heard the tone.
      }
    },
    [context],
  );
}
