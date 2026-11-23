'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { palletSerialOf, type ClassifiedScan } from '@dayson/domain';
import { LabelPrint } from '@/components/floor/LabelPrint';
import { ScanFlow, type StepValidation } from '@/components/floor/ScanFlow';
import { BigButton, Card, EmptyState, NoticeBanner, OfflineNotice, SectionTitle, TextField, notice, type Notice } from '@/components/floor/ui';
import { t } from '@/i18n';
import type { LabelData, MoveResult } from '@/lib/data/floor-cmd';
import { listConsolidation, scanLookup } from '@/lib/data/floor-read';
import { parseQty } from '@/lib/floor/format';
import { flowScanMethod, type ScanStep, type StepValue } from '@/lib/floor/scan-flow';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { manualReasonOf, useFloor, type FloorResult } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

interface Preset {
  from: string | null;
  to: string | null;
  taskId: string | null;
  label: string;
}

type Outcome =
  | { status: 'done'; serial: string; to: string; cartonLabels: boolean; label: LabelData | null }
  | { status: 'queued'; serial: string; to: string };

/** Transfer (spec 5.1, 5.6): ad hoc pallet move confirmed by three scans, plus lane consolidation proposals. */
export function TransferScreen() {
  const floor = useFloor('transfer');
  const { run, logScan } = floor;
  const params = useSearchParams();
  const consolidation = useCachedQuery('transfer.consolidation', listConsolidation);

  const [preset, setPreset] = useState<Preset | null>(() => {
    const from = params.get('from');
    const to = params.get('to');
    const taskId = params.get('task');
    return from || to || taskId ? { from, to, taskId, label: t('floor.transfer.fromTask') } : null;
  });
  const [round, setRound] = useState(0);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copies, setCopies] = useState('1');

  const validate = useCallback(
    async (step: ScanStep, scan: ClassifiedScan, values: Record<string, StepValue>): Promise<StepValidation> => {
      if (step.key === 'source') {
        if (preset?.from && scan.kind === 'location' && scan.code !== preset.from) return { ok: false, message: t('floor.transfer.expectedSource', { code: preset.from }) };
        return { ok: true };
      }
      if (step.key === 'pallet') {
        const serial = palletSerialOf(scan);
        if (!serial) return { ok: false, message: t('floor.transfer.noSerial') };
        const source = values.source?.scan;
        try {
          const found = await scanLookup(getBrowserSupabase(), { code: serial });
          if (found.kind !== 'pallet') return { ok: false, code: 'UNKNOWN_PALLET' };
          if (found.pallet.status !== 'active' || !found.location) return { ok: false, code: 'INVALID_STATE' };
          if (source?.kind === 'location' && found.location !== source.code) return { ok: false, code: 'WRONG_LOCATION' };
          if (found.pallet.shipment_id) return { ok: false, code: 'ALREADY_PICKED' };
        } catch {
          // Offline: accept the scan; the server checks the move on replay.
        }
        return { ok: true };
      }
      const source = values.source?.scan;
      if (scan.kind === 'location' && source?.kind === 'location' && scan.code === source.code) return { ok: false, message: t('floor.putaway.sameLocation') };
      if (preset?.to && scan.kind === 'location' && scan.code !== preset.to) return { ok: false, message: t('floor.transfer.expectedDestination', { code: preset.to }) };
      return { ok: true };
    },
    [preset],
  );

  const onComplete = async (values: Record<string, StepValue>) => {
    const source = values.source.scan;
    const destination = values.destination.scan;
    const serial = palletSerialOf(values.pallet.scan);
    if (source.kind !== 'location' || destination.kind !== 'location' || !serial) return;
    const to = destination.code;
    const settle = (result: FloorResult<MoveResult>) => {
      if (result.status === 'rejected') {
        setOutcome(null);
        setMsg(notice('bad', result.text));
        return;
      }
      setMsg(null);
      if (result.status === 'done') {
        setOutcome({ status: 'done', serial, to: result.data.to_location ?? to, cartonLabels: result.data.carton_labels, label: result.data.label });
        consolidation.reload();
      } else setOutcome({ status: 'queued', serial, to });
    };
    const metas = Object.values(values);
    const result = await run<MoveResult>(
      'transfer',
      {
        pallet_serial: serial,
        from_location: source.code,
        to_location: to,
        task_id: preset?.taskId ?? undefined,
        scan_method: flowScanMethod(values),
        reason_code: manualReasonOf(...metas),
      },
      { event_at: values.destination.scanned_at, onLate: settle },
    );
    settle(result);
    if (result.status !== 'rejected' && preset?.taskId) setPreset(null);
    // Ready for the next pallet at once.
    setRound((n) => n + 1);
  };

  const proposals = consolidation.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      {preset ? (
        <Card className="border-ink" testid="transfer-preset">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted">{preset.label}</p>
          <p className="font-mono text-2xl font-extrabold">
            {preset.from ?? '…'} → {preset.to ?? '…'}
          </p>
          <BigButton tone="ghost" className="mt-2" onClick={() => { setPreset(null); setRound((n) => n + 1); }}>
            {t('floor.transfer.freeMove')}
          </BigButton>
        </Card>
      ) : null}

      <ScanFlow
        key={round}
        context="transfer"
        logScan={logScan}
        validate={validate}
        onComplete={onComplete}
        hideDone
        hints={{ source: preset?.from ?? undefined, destination: preset?.to ?? undefined }}
      />
      <NoticeBanner value={msg} />

      {outcome ? (
        <div role="status" data-testid="transfer-result" data-status={outcome.status} className={`rounded-xl px-4 py-3 ${outcome.status === 'done' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
          <p className="text-lg font-extrabold">{outcome.status === 'done' ? t('floor.transfer.done') : t('floor.common.queued')}</p>
          <p className="font-mono text-lg font-extrabold">
            {outcome.serial} → {outcome.to}
          </p>
        </div>
      ) : null}
      {outcome?.status === 'done' && outcome.cartonLabels && outcome.label ? (
        <Card testid="carton-labels">
          <p className="text-base font-extrabold">{t('floor.transfer.cartonTitle')}</p>
          <p className="text-sm text-ink-soft">{t('floor.transfer.cartonBody')}</p>
          <div className="mt-2">
            <TextField label={t('floor.transfer.copies')} value={copies} onChange={setCopies} numeric testid="carton-copies" />
          </div>
          <div className="mt-2">
            <LabelPrint job={{ template: 'carton', label: outcome.label, copies: Math.min(50, Math.max(1, Math.round(parseQty(copies) ?? 1))) }} />
          </div>
        </Card>
      ) : null}

      <SectionTitle count={proposals.length}>{t('floor.transfer.consolidation')}</SectionTitle>
      <OfflineNotice stale={consolidation.stale} fetchedAt={consolidation.fetchedAt} />
      {proposals.length === 0 ? (
        <EmptyState>{consolidation.data ? t('floor.transfer.noConsolidation') : t('floor.common.offlineNoData')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {proposals.map((p) => (
            <li key={`${p.from_location_id}.${p.to_location_id}`}>
              <button
                type="button"
                data-testid="consolidation"
                onClick={() => {
                  setPreset({ from: p.from_code, to: p.to_code, taskId: null, label: t('floor.transfer.consolidationOf', { sku: p.sku }) });
                  setOutcome(null);
                  setMsg(null);
                  setRound((n) => n + 1);
                }}
                className="flex min-h-16 w-full flex-col items-start rounded-xl border-2 border-line bg-paper px-3 py-2 text-left active:bg-surface"
              >
                <span className="font-mono text-lg font-extrabold">
                  {p.from_code} → {p.to_code}
                </span>
                <span className="text-sm text-ink-soft">
                  {p.sku} · {t('scan.field.lot')} {p.lot_no ?? '—'} · {t('floor.transfer.lanePallets', { from: p.from_pallets, to: p.to_pallets })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
