'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import { submitFloor, type FloorCmd } from '@/lib/data/floor-cmd';
import { createScanLogger, type LogScan, type ScanLogger } from '@/lib/data/scan-log';
import { errorText } from './errors';
import { feedback } from './feedback';
import { deviceId } from './format';
import type { Outbox } from './outbox/engine';
import { useOutbox } from './outbox/react';
import type { ScanMeta } from './scan-flow';
import { stepKindOf } from './use-scan-logger';

export type FloorResult<T = Record<string, unknown>> =
  | { status: 'done'; data: T; client_uuid: string }
  | { status: 'queued'; client_uuid: string }
  | { status: 'rejected'; code: string; message: string; text: string; client_uuid: string };

export interface RunOptions<T> {
  event_at?: string;
  waitMs?: number;
  /** No tone: the caller plays its own (e.g. one tone for a batch). */
  silent?: boolean;
  /** Called when a command that was only queued gets its answer later, while the screen is still open. */
  onLate?: (result: FloorResult<T>) => void;
}

// One batching scan logger per outbox, so screens share the buffer.
const loggers = new WeakMap<Outbox, ScanLogger>();
function loggerFor(outbox: Outbox): ScanLogger {
  let logger = loggers.get(outbox);
  if (!logger) {
    // enqueue() only stores the batch; start a replay so the log leaves the device promptly.
    const sender = {
      enqueue: async (...args: Parameters<Outbox['enqueue']>) => {
        const command = await outbox.enqueue(...args);
        void outbox.drain();
        return command;
      },
    };
    logger = createScanLogger(sender, { deviceId: deviceId() });
    loggers.set(outbox, logger);
  }
  return logger;
}

/**
 * What every floor screen needs: post a command through the outbox, play the
 * accepted / refused tone, and log scans (batched) to rpc_log_scans.
 */
export function useFloor(screen: string) {
  const ob = useOutbox();
  const { outbox, submit, acknowledgeRejected, online, queued, rejected } = ob;

  const logger = useMemo(() => (outbox ? loggerFor(outbox) : null), [outbox]);

  // Do not lose buffered scan events when the app is put away.
  useEffect(() => {
    if (!logger) return;
    const flush = () => {
      if (document.visibilityState === 'hidden') void logger.flush();
    };
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      void logger.flush();
    };
  }, [logger]);

  const logScan = useMemo<LogScan>(() => (entry) => logger?.log(entry), [logger]);

  const log = useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, reason: string, step?: string) => {
      void logger?.log({
        raw: scan.raw,
        kind: scan.kind,
        context: screen,
        reason,
        accepted: reason === 'accepted',
        step: stepKindOf(step),
        method: meta.method,
        reason_code: meta.reason_code,
        scanned_at: new Date().toISOString(),
      });
    },
    [logger, screen],
  );

  /** Accepted tone + log entry for a confirmation scan. */
  const accept = useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, step?: string) => {
      feedback('accepted');
      log(scan, meta, 'accepted', step);
    },
    [log],
  );

  /** Refused tone + log entry. */
  const refuse = useCallback(
    (scan: ClassifiedScan, meta: ScanMeta, reason: string, step?: string) => {
      feedback('refused');
      log(scan, meta, reason, step);
    },
    [log],
  );

  const run = useCallback(
    async <T = Record<string, unknown>>(cmd: FloorCmd, args: Record<string, unknown>, options: RunOptions<T> = {}): Promise<FloorResult<T>> => {
      const result = await submitFloor({ submit }, cmd, args, {
        event_at: options.event_at,
        waitMs: options.waitMs,
        device_id: deviceId(),
      });
      if (result.status === 'done') {
        if (!options.silent) feedback('accepted');
        return { status: 'done', data: result.data as T, client_uuid: result.client_uuid };
      }
      if (result.status === 'rejected') {
        if (!options.silent) feedback('refused');
        // The operator sees this refusal right now, so it is not left as "unseen" in the rejected list.
        void acknowledgeRejected(result.client_uuid).catch(() => {});
        return {
          status: 'rejected',
          code: result.code,
          message: result.message,
          text: errorText(result.code, result.message),
          client_uuid: result.client_uuid,
        };
      }
      // Queued: offline or slow. The scan itself is accepted; the answer comes on replay.
      if (!options.silent) feedback('accepted');
      const onLate = options.onLate;
      if (onLate && outbox) {
        const off = outbox.onSettled((event) => {
          if (event.command.client_uuid !== result.client_uuid) return;
          off();
          if (event.status === 'done') onLate({ status: 'done', data: event.data as T, client_uuid: result.client_uuid });
          else {
            onLate({
              status: 'rejected',
              code: event.code,
              message: event.message,
              text: errorText(event.code, event.message),
              client_uuid: result.client_uuid,
            });
          }
        });
      }
      return { status: 'queued', client_uuid: result.client_uuid };
    },
    [submit, acknowledgeRejected, outbox],
  );

  return { run, log, logScan, accept, refuse, online, queued, rejected };
}

/** scan_method of a command: "manual" as soon as one confirmation was typed. */
export function methodOf(...metas: (ScanMeta | undefined | null)[]): 'scan' | 'manual' {
  return metas.some((m) => m?.method === 'manual') ? 'manual' : 'scan';
}

/** The reason picked for the manual entry, if any. */
export function manualReasonOf(...metas: (ScanMeta | undefined | null)[]): string | undefined {
  return metas.find((m) => m?.method === 'manual' && m.reason_code)?.reason_code;
}
