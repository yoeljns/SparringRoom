'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { palletSerialOf, type ClassifiedScan } from '@dayson/domain';
import { LabelPrint } from '@/components/floor/LabelPrint';
import { ScanInput } from '@/components/floor/ScanInput';
import {
  BigButton,
  Card,
  ChoiceGrid,
  EmptyState,
  Loading,
  NoticeBanner,
  OfflineNotice,
  RefreshButton,
  SectionTitle,
  StepList,
  TextField,
  notice,
  type Notice,
} from '@/components/floor/ui';
import { formatIsoDate, t } from '@/i18n';
import type { LabelData, PickResult } from '@/lib/data/floor-cmd';
import { listLocations, listTasks, scanLookup, type TaskRow } from '@/lib/data/floor-read';
import { feedback } from '@/lib/floor/feedback';
import { fmtQty, parseQty } from '@/lib/floor/format';
import type { ScanMeta } from '@/lib/floor/scan-flow';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { manualReasonOf, methodOf, useFloor } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

interface Scanned {
  serial: string;
  meta: ScanMeta;
}

interface PickLine {
  serial: string | null;
  status: 'done' | 'queued' | 'rejected';
  text?: string;
  picked?: number;
  remaining?: number;
  swapped?: boolean;
  label?: LabelData | null;
}

/** Toplama (spec 5.4): pick tasks per truck; scan the lane, each pallet, then the staging lane. */
export function PickScreen() {
  const floor = useFloor('pick');
  const { run, accept, refuse } = floor;
  const params = useSearchParams();

  const fetchPicks = useCallback((sb: Parameters<typeof listTasks>[0]) => listTasks(sb, 'pick'), []);
  const tasksQuery = useCachedQuery('pick.tasks', fetchPicks);
  const locationsQuery = useCachedQuery('locations', listLocations);

  const [shipmentId, setShipmentId] = useState<string | null>(params.get('shipment'));
  const [taskId, setTaskId] = useState<string | null>(params.get('task'));
  const [lane, setLane] = useState<{ code: string; meta: ScanMeta } | null>(null);
  const [pallets, setPallets] = useState<Scanned[]>([]);
  const [qty, setQty] = useState('');
  const [uom, setUom] = useState<'piece' | 'carton'>('piece');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [lines, setLines] = useState<PickLine[]>([]);
  const [chosen, setChosen] = useState<{ id: string; no: string; party: string | null } | null>(null);

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const trucks = useMemo(() => {
    const map = new Map<string, { id: string; no: string; party: string | null; tasks: TaskRow[] }>();
    for (const task of tasks) {
      if (!task.shipment_id) continue;
      const truck = map.get(task.shipment_id) ?? { id: task.shipment_id, no: task.shipment_no ?? '—', party: task.party_name, tasks: [] };
      truck.tasks.push(task);
      map.set(task.shipment_id, truck);
    }
    return [...map.values()].sort((a, b) => a.no.localeCompare(b.no));
  }, [tasks]);

  // A truck whose last task was just picked has no tasks left, but stays on screen.
  const truck =
    trucks.find((x) => x.id === shipmentId) ??
    (shipmentId && tasksQuery.data ? { id: shipmentId, no: chosen?.id === shipmentId ? chosen.no : '', party: chosen?.id === shipmentId ? chosen.party : null, tasks: [] as TaskRow[] } : null);
  const task = truck ? (truck.tasks.find((x) => x.id === taskId) ?? truck.tasks[0] ?? null) : null;
  const typeOf = (code: string | null) => locationsQuery.data?.find((l) => l.code === code)?.type ?? null;
  const isCarton = task ? typeOf(task.location_code) === 'pick_face' : false;

  const reset = () => {
    setLane(null);
    setPallets([]);
    setQty('');
    setMsg(null);
  };

  const chooseTask = (id: string) => {
    setTaskId(id);
    setLines([]);
    reset();
  };

  const submit = async (staging: string, stagingMeta: ScanMeta) => {
    if (!task || !lane) return;
    setBusy(true);
    const out: PickLine[] = [];
    const jobs: { serial: string | null; meta: ScanMeta | null }[] = isCarton ? [{ serial: null, meta: null }] : pallets.map((p) => ({ serial: p.serial, meta: p.meta }));
    for (const job of jobs) {
      const result = await run<PickResult>(
        'pick',
        {
          task_id: task.id,
          lane: lane.code,
          pallet_serial: job.serial ?? undefined,
          qty: isCarton ? (parseQty(qty) ?? undefined) : undefined,
          uom: isCarton ? (uom === 'carton' ? 'carton' : undefined) : undefined,
          to_location: staging,
          scan_method: methodOf(lane.meta, job.meta, stagingMeta),
          reason_code: manualReasonOf(lane.meta, job.meta, stagingMeta),
        },
        { silent: true },
      );
      if (result.status === 'done') {
        out.push({
          serial: job.serial,
          status: 'done',
          picked: Number(result.data.picked_qty),
          remaining: Number(result.data.remaining),
          swapped: result.data.reservation_swapped,
          label: result.data.label,
        });
      } else if (result.status === 'queued') out.push({ serial: job.serial, status: 'queued' });
      else out.push({ serial: job.serial, status: 'rejected', text: result.text });
    }
    const refused = out.some((l) => l.status === 'rejected');
    feedback(refused ? 'refused' : 'accepted');
    setLines(out);
    setMsg(refused ? notice('bad', t('floor.pick.someRefused')) : null);
    setLane(null);
    setPallets([]);
    setQty('');
    setBusy(false);
    if (truck) setChosen({ id: truck.id, no: truck.no, party: truck.party });
    tasksQuery.reload();
  };

  const onScan = async (scan: ClassifiedScan, meta: ScanMeta) => {
    if (!task || busy) return;
    if (scan.kind === 'unknown') {
      refuse(scan, meta, 'unknown');
      setMsg(notice('bad', t('scan.refused.unknown')));
      return;
    }
    const serial = palletSerialOf(scan);

    // 1. lane (or pick face)
    if (!lane) {
      if (scan.kind !== 'location') {
        refuse(scan, meta, 'wrong_kind', 'source');
        setMsg(notice('bad', t('floor.pick.scanLaneFirst')));
        return;
      }
      if (isCarton && scan.code !== task.location_code) {
        refuse(scan, meta, 'WRONG_LOCATION', 'source');
        setMsg(notice('bad', t('floor.errors.WRONG_LOCATION')));
        return;
      }
      accept(scan, meta, 'source');
      setLines([]);
      setLane({ code: scan.code, meta });
      if (isCarton && !qty) setQty(String(task.qty_base ?? ''));
      // Another lane is allowed: the server swaps the reservation if that lot passes the rules.
      setMsg(scan.code !== task.location_code ? notice('warn', t('floor.pick.otherLane', { code: task.location_code ?? '' })) : null);
      return;
    }

    // 2. pallets
    if (serial) {
      if (isCarton) {
        refuse(scan, meta, 'wrong_kind', 'pallet');
        setMsg(notice('bad', t('floor.pick.cartonNoPallet')));
        return;
      }
      if (pallets.some((p) => p.serial === serial)) {
        refuse(scan, meta, 'duplicate', 'pallet');
        setMsg(notice('bad', t('floor.pick.duplicate')));
        return;
      }
      // Quick check while online; the server checks again when the pick is posted.
      setBusy(true);
      let problem: string | null = null;
      try {
        const found = await scanLookup(getBrowserSupabase(), { code: serial });
        if (found.kind !== 'pallet') problem = 'UNKNOWN_PALLET';
        else if (found.pallet.item_id !== task.item_id) problem = 'WRONG_ITEM';
        else if (found.pallet.shipment_id) problem = 'ALREADY_PICKED';
        else if (found.location !== lane.code) problem = 'WRONG_LOCATION';
      } catch {
        problem = null;
      }
      setBusy(false);
      if (problem) {
        refuse(scan, meta, problem, 'pallet');
        setMsg(notice('bad', t(`floor.errors.${problem as 'UNKNOWN_PALLET' | 'WRONG_ITEM' | 'ALREADY_PICKED' | 'WRONG_LOCATION'}`)));
        return;
      }
      accept(scan, meta, 'pallet');
      setPallets((list) => [...list, { serial, meta }]);
      setMsg(null);
      return;
    }

    // 3. staging lane
    if (scan.kind === 'location') {
      const type = typeOf(scan.code);
      if (type && type !== 'staging') {
        refuse(scan, meta, 'not_staging', 'destination');
        setMsg(notice('bad', t('floor.pick.notStaging', { code: scan.code })));
        return;
      }
      if (!isCarton && pallets.length === 0) {
        refuse(scan, meta, 'no_pallet', 'destination');
        setMsg(notice('bad', t('floor.pick.scanPalletFirst')));
        return;
      }
      if (isCarton && !(parseQty(qty) ?? 0)) {
        refuse(scan, meta, 'no_qty', 'destination');
        setMsg(notice('bad', t('floor.receive.qtyRequired')));
        return;
      }
      floor.log(scan, meta, 'accepted', 'destination');
      await submit(scan.code, meta);
    }
  };

  // ---- truck list -------------------------------------------------------------

  if (!truck) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle count={trucks.length}>{t('floor.pick.trucks')}</SectionTitle>
          <RefreshButton onClick={tasksQuery.reload} busy={tasksQuery.loading} />
        </div>
        <OfflineNotice stale={tasksQuery.stale} fetchedAt={tasksQuery.fetchedAt} />
        {lines.length > 0 ? <PickLines lines={lines} /> : null}
        {tasksQuery.loading && !tasksQuery.data ? (
          <Loading />
        ) : trucks.length === 0 ? (
          <EmptyState>{tasksQuery.data ? t('floor.pick.empty') : t('floor.common.offlineNoData')}</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {trucks.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  data-testid="pick-truck"
                  data-shipment={x.no}
                  onClick={() => {
                    setShipmentId(x.id);
                    setChosen({ id: x.id, no: x.no, party: x.party });
                    setTaskId(null);
                    setLines([]);
                    reset();
                  }}
                  className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border-2 border-ink bg-paper px-3 py-2 text-left active:bg-surface"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xl font-extrabold">{x.no}</span>
                    <span className="block truncate text-base text-ink-soft">{x.party ?? ''}</span>
                  </span>
                  <span className="shrink-0 text-right text-base font-bold tabular-nums">
                    {t('floor.pick.taskCount', { n: x.tasks.length })}
                    <span className="block text-sm font-semibold text-muted">
                      {t('floor.common.pallets', { n: fmtQty(x.tasks.reduce((n, k) => n + Number(k.pallets ?? 0), 0)) })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- one truck ----------------------------------------------------------------

  const lastRemaining = lines.filter((l) => l.status === 'done').at(-1)?.remaining;
  return (
    <div className="flex flex-col gap-3">
      <Card testid="pick-truck-header">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-xl font-extrabold">{truck.no}</p>
            <p className="truncate text-base text-ink-soft">{truck.party ?? ''}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShipmentId(null);
              reset();
            }}
            className="min-h-12 shrink-0 rounded-lg border-2 border-line-strong bg-paper px-3 text-sm font-bold"
          >
            {t('floor.pick.otherTruck')}
          </button>
        </div>
        <p className="mt-1 text-sm font-bold text-ink-soft" data-testid="pick-remaining-tasks">
          {t('floor.pick.remainingTasks', { n: truck.tasks.length })}
        </p>
      </Card>
      <OfflineNotice stale={tasksQuery.stale} fetchedAt={tasksQuery.fetchedAt} />

      {task ? (
        <>
          <Card className="border-ink" testid="pick-task">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold uppercase tracking-wide text-muted">{isCarton ? t('floor.pick.pickFace') : t('floor.pick.lane')}</p>
                <p className="font-mono text-3xl font-extrabold leading-tight" data-testid="pick-lane">
                  {task.location_code ?? '—'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold uppercase tracking-wide text-muted">{t('floor.pick.toTake')}</p>
                <p className="text-2xl font-extrabold tabular-nums" data-testid="pick-to-take">
                  {isCarton ? fmtQty(task.qty_base) : t('floor.common.pallets', { n: fmtQty(task.pallets) })}
                </p>
                {!isCarton ? <p className="text-sm font-semibold tabular-nums text-muted">{fmtQty(task.qty_base)}</p> : null}
              </div>
            </div>
            <p className="mt-2 text-base font-bold">{task.sku}</p>
            <p className="truncate text-sm text-ink-soft">{task.item_name}</p>
            <p className="mt-1 font-mono text-base font-semibold">
              {t('scan.field.lot')} {task.lot_no ?? '—'}
              {task.expiry_date ? ` · ${t('floor.common.expiryShort')} ${formatIsoDate(task.expiry_date)}` : ''}
            </p>
          </Card>

          <StepList
            steps={[
              { key: 'source', label: isCarton ? t('floor.pick.pickFace') : t('floor.pick.lane'), state: lane ? 'done' : 'current', value: lane?.code, hint: task.location_code },
              isCarton
                ? { key: 'qty', label: t('floor.common.qty'), state: lane ? 'current' : 'pending', value: lane ? qty : null }
                : {
                    key: 'pallet',
                    label: t('floor.pick.palletsScanned', { n: pallets.length }),
                    state: !lane ? 'pending' : pallets.length > 0 ? 'done' : 'current',
                    value: pallets.map((p) => p.serial.slice(-6)).join(', ') || null,
                  },
              { key: 'destination', label: t('floor.pick.staging'), state: lane && (isCarton || pallets.length > 0) ? 'current' : 'pending' },
            ]}
          />
          {isCarton && lane ? (
            <div className="grid grid-cols-[1fr_1.4fr] gap-2">
              <TextField label={t('floor.common.qty')} value={qty} onChange={setQty} numeric testid="pick-qty" />
              <ChoiceGrid
                options={[
                  { value: 'piece' as const, label: t('floor.uom.piece') },
                  { value: 'carton' as const, label: t('floor.uom.carton') },
                ]}
                value={uom}
                onChange={setUom}
                label={t('floor.common.unit')}
              />
            </div>
          ) : null}
          <ScanInput
            onScan={(scan, meta) => void onScan(scan, meta)}
            disabled={busy}
            prompt={!lane ? t('floor.pick.scanLane') : isCarton || pallets.length > 0 ? t('floor.pick.scanStagingOrPallet') : t('floor.pick.scanPallet')}
          />
          <NoticeBanner value={msg} />
          {lane || pallets.length > 0 ? (
            <BigButton tone="ghost" onClick={reset}>
              {t('flow.restart')}
            </BigButton>
          ) : null}
        </>
      ) : (
        <div role="status" data-testid="pick-truck-done" className="rounded-xl bg-ok-soft px-4 py-3 text-ok">
          <p className="text-lg font-extrabold">{t('floor.pick.truckDone')}</p>
          <Link href={`/floor/load?shipment=${shipmentId}`} className="mt-2 flex min-h-14 items-center justify-center rounded-xl bg-ink text-lg font-bold text-paper" data-testid="pick-go-load">
            {t('floor.pick.goLoad')}
          </Link>
        </div>
      )}

      {lines.length > 0 ? <PickLines lines={lines} remaining={lastRemaining} /> : null}

      {truck.tasks.length > 1 ? (
        <>
          <SectionTitle count={truck.tasks.length}>{t('floor.pick.allTasks')}</SectionTitle>
          <ul className="flex flex-col gap-2">
            {truck.tasks.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => chooseTask(x.id)}
                  data-testid="pick-task-row"
                  className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border-2 px-3 py-2 text-left ${x.id === task?.id ? 'border-ink bg-surface' : 'border-line bg-paper'}`}
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-lg font-extrabold">{x.location_code}</span>
                    <span className="block truncate text-sm text-ink-soft">
                      {x.sku} · {x.lot_no ?? '—'}
                    </span>
                  </span>
                  <span className="shrink-0 text-base font-bold tabular-nums">{t('floor.common.pallets', { n: fmtQty(x.pallets) })}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PickLines({ lines, remaining }: { lines: PickLine[]; remaining?: number }) {
  return (
    <Card testid="pick-result">
      <p className="text-base font-extrabold">{t('floor.pick.result')}</p>
      <ul className="mt-1 flex flex-col gap-2">
        {lines.map((line, i) => (
          <li key={line.serial ?? i} data-status={line.status} className="border-t border-line pt-2 first:border-t-0 first:pt-0">
            <p className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-base font-bold">{line.serial ?? t('floor.pick.cartons')}</span>
              <span className={`text-base font-extrabold ${line.status === 'done' ? 'text-ok' : line.status === 'queued' ? 'text-warn' : 'text-brand'}`}>
                {line.status === 'done' ? t('floor.pick.picked', { qty: fmtQty(line.picked) }) : line.status === 'queued' ? t('floor.common.queuedShort') : t('floor.common.refused')}
              </span>
            </p>
            {line.text ? <p className="text-base font-semibold text-brand-dark">{line.text}</p> : null}
            {line.swapped ? (
              <p className="text-sm font-bold text-warn" data-testid="pick-swapped">
                {t('floor.pick.swapped')}
              </p>
            ) : null}
            {line.label ? (
              <div className="mt-2">
                <LabelPrint job={{ template: 'pallet', label: line.label }} title={t('floor.pick.newPalletLabel')} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {remaining !== undefined ? (
        <p className="mt-2 border-t border-line pt-2 text-lg font-extrabold" data-testid="pick-remaining">
          {t('floor.pick.remaining', { qty: fmtQty(remaining) })}
        </p>
      ) : null}
    </Card>
  );
}
