'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import type { LogScan } from '@/lib/data/scan-log';
import type { ScanMeta } from './scan-flow';

/**
 * Returns a function that logs a refused scan through the injected `logScan`.
 * Logging never blocks or breaks the scan screen.
 */
export function useScanLogger(logScan: LogScan | undefined, context: string) {
  const ref = useRef(logScan);
  useEffect(() => {
    ref.current = logScan;
  }, [logScan]);
  return useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, reason: string) => {
      const fn = ref.current;
      if (!fn) return;
      try {
        const result = fn({
          raw: scan.raw,
          kind: scan.kind,
          context,
          reason,
          method: meta.method,
          scanned_at: new Date().toISOString(),
        });
        if (result instanceof Promise) result.catch(() => {});
      } catch {
        // Ignore: the operator has already heard the refusal tone.
      }
    },
    [context],
  );
}
