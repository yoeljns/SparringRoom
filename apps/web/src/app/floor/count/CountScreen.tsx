'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import { BlockUntilDrained } from '@/components/floor/BlockUntilDrained';
import { ScanInput } from '@/components/floor/ScanInput';
import {
  Banner,
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
import { t, tDynamic } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import type { CountResult } from '@/lib/data/floor-cmd';
import { listCountTasks, stockAtLocation, type CountTaskRow } from '@/lib/data/floor-read';
import { parseQty } from '@/lib/floor/format';
import type { ScanMeta } from '@/lib/floor/scan-flow';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { manualReasonOf, useFloor } from '@/lib/floor/use-floor';

const VARIANCE_REASONS = ['miscount', 'damaged', 'misplaced', 'unrecorded_move', 'theft_loss', 'other'] as const;

type Uom = 'pallet' | 'carton' | 'piece';

/**
 * Sayım (spec 5.5): blind counts. The expected quantity is never read or
 * shown; the operator scans the location and enters what is there. A recount
 * is done by a different user and carries a reason for the variance.
 */
export function CountScreen() {
  const floor = useFloor('count');
  const { run, accept, refuse } = floor;
  const { profile, role } = useProfile();
  const params = useSearchParams();

  const query = useCachedQuery('count.tasks', listCountTasks);
  const [taskId, setTaskId] = useState<string | null>(params.get('task'));
  const [located, setLocated] = useState<ScanMeta | null>(null);
  const [qty, setQty] = useState('');
  const [uomChoice, setUom] = useState<Uom | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);
  const [result, setResult] = useState<{ location: string; state: CountResult['state'] | 'queued' } | null>(null);

  const tasks = useMemo(() => {
    const all = query.data ?? [];
    const seeAll = role === 'owner' || role === 'ops_manager';
    return all.filter((c) => !c.assigned_to || c.assigned_to === profile?.id || seeAll);
  }, [query.data, role, profile?.id]);
  const task = tasks.find((x) => x.id === taskId) ?? null;

  // A task without an item (exception count): offer the items known at that location, never their quantities.
  const locationId = task && !task.item_id ? task.location_id : null;
  const fetchItems = useCallback(
    async (sb: Parameters<typeof stockAtLocation>[0]) => {
      const stock = await stockAtLocation(sb, locationId ?? '');
      const seen = new Map<string, { id: string; sku: string; name: string }>();
      for (const s of stock) seen.set(s.item_id, { id: s.item_id, sku: s.sku, name: s.item_name });
      return [...seen.values()];
    },
    [locationId],
  );
  const itemsQuery = useCachedQuery(locationId ? `count.items.${locationId}` : null, fetchItems);
  const itemChoices = itemsQuery.data ?? [];
  const chosenItem = itemId ?? (itemChoices.length === 1 ? itemChoices[0].id : null);

  const isRecount = task?.state === 'recount';
  const sameUser = isRecount && !!task?.counted_by && task.counted_by === profile?.id;
  const palletsCounted = task?.location_type !== 'pick_face' && task?.location_type !== 'consignment';
  const uom: Uom = uomChoice ?? (palletsCounted ? 'pallet' : 'piece');

  const choose = (next: CountTaskRow) => {
    setTaskId(next.id);
    setLocated(null);
    setQty('');
    setUom(null);
    setReason(null);
    setItemId(null);
    setMsg(null);
    setResult(null);
  };

  const back = () => {
    setTaskId(null);
    setLocated(null);
    setMsg(null);
    query.reload();
  };

  const onScan = (scan: ClassifiedScan, meta: ScanMeta) => {
    if (!task || busy) return;
    if (scan.kind !== 'location') {
      refuse(scan, meta, scan.kind === 'unknown' ? 'unknown' : 'wrong_kind', 'source');
      setMsg(notice('bad', scan.kind === 'unknown' ? t('scan.refused.unknown') : t('floor.count.scanLocationOnly')));
      return;
    }
    if (scan.code !== task.location_code) {
      refuse(scan, meta, 'WRONG_LOCATION', 'source');
      setMsg(notice('bad', t('floor.count.wrongLocation', { code: task.location_code })));
      return;
    }
    accept(scan, meta, 'source');
    setLocated(meta);
    setMsg(null);
  };

  const counted = parseQty(qty);
  const problem = !located
    ? t('floor.count.scanFirst')
    : counted === null
      ? t('floor.count.qtyRequired')
      : isRecount && !reason
        ? t('floor.count.reasonRequired')
        : null;

  const submit = async () => {
    if (!task || !located || counted === null) return;
    setBusy(true);
    const res = await run<CountResult>('count', {
      count_task_id: task.id,
      qty: counted,
      uom: uom === 'piece' ? undefined : uom,
      item_id: task.item_id ? undefined : (chosenItem ?? undefined),
      // Needed only when a recount confirms the variance; the server ignores it otherwise.
      reason_code: isRecount ? reason : manualReasonOf(located),
      scan_method: located.method,
    });
    setBusy(false);
    if (res.status === 'rejected') {
      setMsg(notice('bad', res.text));
      return;
    }
    setResult({ location: task.location_code, state: res.status === 'done' ? res.data.state : 'queued' });
    setTaskId(null);
    setLocated(null);
    setQty('');
    setMsg(null);
    query.reload();
  };

  // ---- list -------------------------------------------------------------------

  if (!task) {
    return (
      <div className="flex flex-col gap-3">
        {result ? (
          <div
            role="status"
            data-testid="count-result"
            data-state={result.state}
            className={`rounded-xl px-4 py-3 ${result.state === 'closed' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}
          >
            <p className="font-mono text-lg font-extrabold">{result.location}</p>
            <p className="text-lg font-extrabold">{t(`floor.count.result.${result.state}`)}</p>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <SectionTitle count={tasks.length}>{t('floor.count.tasks')}</SectionTitle>
          <RefreshButton onClick={query.reload} busy={query.loading} />
        </div>
        <OfflineNotice stale={query.stale} fetchedAt={query.fetchedAt} />
        {query.loading && !query.data ? (
          <Loading />
        ) : tasks.length === 0 ? (
          <EmptyState>{query.data ? t('floor.count.empty') : t('floor.common.offlineNoData')}</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid="count-task"
                  data-location={c.location_code}
                  data-state={c.state}
                  onClick={() => choose(c)}
                  className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border-2 border-line bg-paper px-3 py-2 text-left active:bg-surface"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-xl font-extrabold">{c.location_code}</span>
                    <span className="block truncate text-sm text-ink-soft">
                      {[c.sku, c.lot_no ? `${t('scan.field.lot')} ${c.lot_no}` : null, tDynamic(`floor.count.trigger.${c.trigger}`, 'floor.count.trigger.other')].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {c.state === 'recount' ? <span className="shrink-0 rounded-full bg-brand px-2 py-1 text-sm font-extrabold text-paper">{t('floor.count.recount')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- one task -----------------------------------------------------------------

  const uoms: { value: Uom; label: string }[] = palletsCounted
    ? [
        { value: 'pallet', label: t('floor.uom.pallet') },
        { value: 'carton', label: t('floor.uom.carton') },
        { value: 'piece', label: t('floor.uom.piece') },
      ]
    : [
        { value: 'piece', label: t('floor.uom.piece') },
        { value: 'carton', label: t('floor.uom.carton') },
      ];

  return (
    <div className="flex flex-col gap-3">
      <Card className="border-ink" testid="count-header">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-3xl font-extrabold leading-tight">{task.location_code}</p>
            <p className="text-base font-bold">{task.sku ?? t('floor.count.anyItem')}</p>
            <p className="truncate text-sm text-ink-soft">
              {task.item_name ?? ''}
              {task.lot_no ? ` · ${t('scan.field.lot')} ${task.lot_no}` : ''}
            </p>
          </div>
          {isRecount ? <span className="shrink-0 rounded-full bg-brand px-2 py-1 text-sm font-extrabold text-paper">{t('floor.count.recount')}</span> : null}
        </div>
        <p className="mt-2 text-sm font-semibold text-muted">{t('floor.count.blind')}</p>
      </Card>

      {sameUser ? (
        <Banner tone="bad" testid="count-same-user">
          {t('floor.errors.RECOUNT_DIFFERENT_USER')}
        </Banner>
      ) : (
        <>
          <StepList
            steps={[
              { key: 'source', label: t('floor.count.stepLocation'), state: located ? 'done' : 'current', value: located ? task.location_code : null, hint: task.location_code },
              { key: 'qty', label: t('floor.count.stepQty'), state: located ? 'current' : 'pending', value: located && qty ? qty : null },
            ]}
          />
          {!located ? <ScanInput onScan={onScan} disabled={busy} prompt={t('floor.count.scanLocation')} /> : null}
          <NoticeBanner value={msg} />

          {located ? (
            <Card>
              <div className="flex flex-col gap-3">
                {!task.item_id && itemChoices.length > 1 ? (
                  <ChoiceGrid
                    options={itemChoices.map((i) => ({ value: i.id, label: i.sku }))}
                    value={chosenItem}
                    onChange={setItemId}
                    label={t('floor.common.item')}
                    testid="count-items"
                  />
                ) : null}
                <TextField label={t('floor.count.counted')} value={qty} onChange={setQty} numeric testid="count-qty" placeholder="0" />
                <ChoiceGrid options={uoms} value={uom} onChange={setUom} label={t('floor.common.unit')} columns={palletsCounted ? 3 : 2} testid="count-uom" />
                {isRecount ? (
                  <ChoiceGrid
                    options={VARIANCE_REASONS.map((code) => ({ value: code, label: t(`floor.count.reasons.${code}`) }))}
                    value={reason}
                    onChange={setReason}
                    label={t('floor.count.varianceReason')}
                    testid="count-reasons"
                  />
                ) : null}
                <BlockUntilDrained>
                  {problem ? <p className="text-base font-bold text-ink-soft">{problem}</p> : null}
                  <BigButton onClick={() => void submit()} disabled={busy || !!problem} data-testid="count-submit">
                    {busy ? t('floor.common.sending') : t('floor.count.submit')}
                  </BigButton>
                </BlockUntilDrained>
              </div>
            </Card>
          ) : null}
        </>
      )}

      <BigButton tone="ghost" onClick={back}>
        {t('floor.count.backToList')}
      </BigButton>
    </div>
  );
}
