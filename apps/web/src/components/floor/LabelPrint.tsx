'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import type { LabelData } from '@/lib/data/floor-cmd';
import { BigButton, Card } from './ui';

export type LabelJob =
  | { template: 'pallet'; label: LabelData }
  | { template: 'carton'; label: LabelData; copies: number };

type State =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'printed' }
  | { status: 'downloaded' }
  | { status: 'no_printer' }
  | { status: 'error'; text: string };

/** Body of POST /api/labels/print for a label returned by rpc_floor; null when data is missing. */
export function labelRequestOf(job: LabelJob): Record<string, unknown> | null {
  const l = job.label;
  if (!l.gtin || !l.lot_no || !l.expiry_date) return null;
  if (job.template === 'carton') {
    return { template: 'carton', copies: job.copies, data: { gtin: l.gtin, sku: l.sku, lot: l.lot_no, expiry: l.expiry_date } };
  }
  if (!l.prod_date || !l.kg || l.kg <= 0) return null;
  return {
    template: 'pallet',
    copies: 1,
    data: {
      sscc: l.serial,
      gtin: l.gtin,
      sku: l.sku,
      description: l.name,
      lot: l.lot_no,
      expiry: l.expiry_date,
      production_date: l.prod_date,
      pallet_kg: l.kg,
    },
  };
}

/**
 * Prints a label through POST /api/labels/print. With PRINTER_HOST set the
 * server sends the ZPL to the printer; without it (503 PRINTER_NOT_CONFIGURED)
 * the operator can download the ZPL file instead.
 */
export function LabelPrint({ job, auto = false, title }: { job: LabelJob; auto?: boolean; title?: string }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const request = labelRequestOf(job);
  const body = request ? JSON.stringify(request) : null;
  const fileName = `${job.template}-${job.label.serial || job.label.sku}.zpl`;

  const send = useCallback(
    async (mode: 'print' | 'download') => {
      if (!body) return;
      setState({ status: 'working' });
      try {
        const res = await fetch('/api/labels/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), mode }),
        });
        if (mode === 'print') {
          if (res.ok) return setState({ status: 'printed' });
          const info = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 503 || info.error === 'PRINTER_NOT_CONFIGURED') return setState({ status: 'no_printer' });
          if (info.error === 'PRINTER_UNREACHABLE') return setState({ status: 'error', text: t('floor.label.unreachable') });
          return setState({ status: 'error', text: t('floor.label.failed') });
        }
        if (!res.ok) return setState({ status: 'error', text: t('floor.label.failed') });
        const zpl = await res.text();
        const url = URL.createObjectURL(new Blob([zpl], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setState({ status: 'downloaded' });
      } catch {
        setState({ status: 'error', text: t('floor.label.offline') });
      }
    },
    [body, fileName],
  );

  // Receiving prints the pallet label by itself, once per label.
  const autoDone = useRef<string | null>(null);
  useEffect(() => {
    if (!auto || !body || autoDone.current === body) return;
    autoDone.current = body;
    void send('print');
  }, [auto, body, send]);

  const heading = title ?? (job.template === 'pallet' ? t('labels.pallet') : t('labels.carton'));

  return (
    <Card testid="label-print">
      <p className="text-base font-extrabold">{heading}</p>
      <p className="font-mono text-base text-ink-soft">{job.template === 'pallet' ? job.label.serial : `${job.label.sku} · ${job.label.lot_no ?? ''}`}</p>
      {!request ? (
        <p className="mt-2 text-base font-semibold text-warn" data-testid="label-status">
          {t('floor.label.missingData')}
        </p>
      ) : (
        <>
          <p className="mt-2 min-h-6 text-base font-semibold" data-testid="label-status" data-status={state.status}>
            {state.status === 'working'
              ? t('floor.label.sending')
              : state.status === 'printed'
                ? t('floor.label.printed')
                : state.status === 'downloaded'
                  ? t('floor.label.downloaded')
                  : state.status === 'no_printer'
                    ? t('floor.label.noPrinter')
                    : state.status === 'error'
                      ? state.text
                      : ''}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <BigButton tone={state.status === 'no_printer' ? 'ghost' : 'primary'} disabled={state.status === 'working'} onClick={() => void send('print')} data-testid="label-print-btn">
              {state.status === 'printed' ? t('floor.label.printAgain') : t('floor.label.print')}
            </BigButton>
            <BigButton tone={state.status === 'no_printer' ? 'primary' : 'ghost'} disabled={state.status === 'working'} onClick={() => void send('download')} data-testid="label-download-btn">
              {t('floor.label.download')}
            </BigButton>
          </div>
        </>
      )}
    </Card>
  );
}
