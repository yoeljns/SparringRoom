'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { BigButton, Banner, Card, ChoiceGrid, EmptyState, Loading, NoticeBanner, OfflineNotice, SectionTitle, TextField, notice, type Notice } from '@/components/floor/ui';
import { t } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import { createCountTask, listDealersFor, listItems, listLocations, stockAtLocation, type PartyRow } from '@/lib/data/floor-read';
import { canUseDealerScreen } from '@/lib/floor/dealer-access';
import { errorText } from '@/lib/floor/errors';
import { fmtQty, parseQty } from '@/lib/floor/format';
import { useCachedQuery } from '@/lib/floor/use-cached-query';
import { useFloor } from '@/lib/floor/use-floor';
import { getBrowserSupabase } from '@/lib/supabase/browser';

type Mode = 'observation' | 'sale';
type Source = 'rep_visual' | 'count' | 'self_report';

/**
 * Bayi: for sales reps on a dealer visit. Records what stock was seen at the
 * dealer (dealer_observation) and consignment stock the dealer has sold
 * (consignment_consume); consignment counts run on the Sayım screen.
 */
export function DealerScreen() {
  const { profile, role, status } = useProfile();
  const { run } = useFloor('dealer');
  const router = useRouter();
  const params = useSearchParams();

  const allowed = canUseDealerScreen(role);
  const fetchDealers = useCallback((sb: Parameters<typeof listItems>[0]) => listDealersFor(sb, profile?.id ?? null, role), [profile?.id, role]);
  const dealersQuery = useCachedQuery(allowed ? 'dealers' : null, fetchDealers);
  const itemsQuery = useCachedQuery(allowed ? 'items' : null, listItems);
  const locationsQuery = useCachedQuery(allowed ? 'locations' : null, listLocations);

  const [partyId, setPartyId] = useState<string | null>(params.get('party'));
  const [mode, setMode] = useState<Mode>('observation');
  const [itemId, setItemId] = useState<string | null>(params.get('item'));
  const [lotId, setLotId] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [source, setSource] = useState<Source>('rep_visual');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(null);

  const dealers = dealersQuery.data ?? [];
  const party: PartyRow | null = dealers.find((d) => d.id === partyId) ?? null;
  const consignment = useMemo(() => locationsQuery.data?.find((l) => l.type === 'consignment' && l.dealer_id === partyId) ?? null, [locationsQuery.data, partyId]);
  const consignmentId = consignment?.id ?? null;
  const fetchStock = useCallback((sb: Parameters<typeof stockAtLocation>[0]) => stockAtLocation(sb, consignmentId ?? ''), [consignmentId]);
  const stockQuery = useCachedQuery(consignmentId ? `dealer.stock.${consignmentId}` : null, fetchStock);

  if (status === 'loading') return <Loading />;
  if (!allowed) {
    return <Banner tone="bad">{t('auth.noAccessTitle')}</Banner>;
  }

  const items = itemsQuery.data ?? [];
  const stock = (stockQuery.data ?? []).filter((s) => s.qty_base > 0);
  const amount = parseQty(qty);
  const item = items.find((i) => i.id === itemId) ?? null;

  const pickDealer = (id: string | null) => {
    setPartyId(id);
    setItemId(null);
    setLotId(null);
    setQty('');
    setMsg(null);
  };

  const submit = async () => {
    if (!party || !itemId || amount === null || (mode === 'sale' && amount <= 0)) return;
    setBusy(true);
    const result =
      mode === 'observation'
        ? await run('dealer_observation', { party_id: party.id, item_id: itemId, qty: amount, source })
        : await run('consignment_consume', { party_id: party.id, item_id: itemId, lot_id: lotId ?? undefined, qty: amount, scan_method: 'manual' });
    setBusy(false);
    if (result.status === 'rejected') {
      setMsg(notice('bad', result.text));
      return;
    }
    const sku = item?.sku ?? stock.find((s) => s.item_id === itemId)?.sku ?? '';
    const text = mode === 'observation' ? t('floor.dealer.observationSaved', { sku, qty: fmtQty(amount) }) : t('floor.dealer.saleSaved', { sku, qty: fmtQty(amount) });
    setMsg(notice(result.status === 'done' ? 'ok' : 'warn', result.status === 'done' ? text : t('floor.common.queued')));
    setQty('');
    setItemId(null);
    setLotId(null);
    stockQuery.reload();
  };

  const startCount = async () => {
    if (!consignment) return;
    setBusy(true);
    try {
      const id = await createCountTask(getBrowserSupabase(), consignment.code, 'visit');
      router.push(`/floor/count?task=${id}`);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code ?? '') : '';
      setMsg(notice('bad', errorText(code || undefined, err instanceof Error ? err.message : String(err))));
    } finally {
      setBusy(false);
    }
  };

  if (!party) {
    return (
      <div className="flex flex-col gap-3">
        <SectionTitle count={dealers.length}>{t('floor.dealer.choose')}</SectionTitle>
        <OfflineNotice stale={dealersQuery.stale} fetchedAt={dealersQuery.fetchedAt} />
        {dealersQuery.loading && !dealersQuery.data ? (
          <Loading />
        ) : dealers.length === 0 ? (
          <EmptyState>{dealersQuery.data ? t('floor.dealer.none') : t('floor.common.offlineNoData')}</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {dealers.map((d) => (
              <li key={d.id}>
                <BigButton tone="ghost" className="justify-start text-left" onClick={() => pickDealer(d.id)} data-testid="dealer">
                  {d.name}
                </BigButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="border-ink">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xl font-extrabold">{party.name}</p>
          <button type="button" onClick={() => pickDealer(null)} className="min-h-12 shrink-0 rounded-lg border-2 border-line-strong bg-paper px-3 text-sm font-bold">
            {t('floor.common.change')}
          </button>
        </div>
        {consignment ? <p className="font-mono text-sm font-semibold text-ink-soft">{consignment.code}</p> : null}
      </Card>

      <ChoiceGrid
        options={[
          { value: 'observation' as const, label: t('floor.dealer.observation') },
          { value: 'sale' as const, label: t('floor.dealer.sale') },
        ]}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setItemId(null);
          setLotId(null);
          setMsg(null);
        }}
        label={t('floor.dealer.action')}
        testid="dealer-mode"
      />
      <NoticeBanner value={msg} />
      <OfflineNotice stale={itemsQuery.stale || stockQuery.stale} fetchedAt={itemsQuery.fetchedAt} />

      {mode === 'observation' ? (
        <>
          <SectionTitle>{t('floor.common.item')}</SectionTitle>
          <ul className="grid grid-cols-1 gap-2">
            {items
              .filter((i) => !itemId || i.id === itemId)
              .map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    data-testid="dealer-item"
                    onClick={() => setItemId(itemId === i.id ? null : i.id)}
                    className={`flex min-h-14 w-full flex-col items-start rounded-xl border-2 px-3 py-2 text-left ${itemId === i.id ? 'border-ink bg-ink text-paper' : 'border-line bg-paper'}`}
                  >
                    <span className="font-mono text-base font-extrabold">{i.sku}</span>
                    <span className="text-sm opacity-80">{i.name}</span>
                  </button>
                </li>
              ))}
          </ul>
        </>
      ) : !consignment ? (
        <EmptyState>{t('floor.dealer.noConsignment')}</EmptyState>
      ) : stock.length === 0 ? (
        <EmptyState>{stockQuery.loading ? t('app.loading') : t('floor.dealer.noConsignmentStock')}</EmptyState>
      ) : (
        <>
          <SectionTitle>{t('floor.dealer.consignmentStock')}</SectionTitle>
          <ul className="grid grid-cols-1 gap-2">
            {stock.map((s) => {
              const on = itemId === s.item_id && lotId === s.lot_id;
              return (
                <li key={`${s.item_id}.${s.lot_id}`}>
                  <button
                    type="button"
                    data-testid="dealer-stock"
                    onClick={() => {
                      setItemId(on ? null : s.item_id);
                      setLotId(on ? null : s.lot_id);
                    }}
                    className={`flex min-h-14 w-full items-center justify-between gap-2 rounded-xl border-2 px-3 py-2 text-left ${on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper'}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-base font-extrabold">{s.sku}</span>
                      <span className="block text-sm opacity-80">
                        {t('scan.field.lot')} {s.lot_no ?? '—'}
                      </span>
                    </span>
                    <span className="shrink-0 text-lg font-extrabold tabular-nums">{fmtQty(s.qty_base)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {itemId ? (
        <Card>
          <div className="flex flex-col gap-3">
            <TextField label={mode === 'observation' ? t('floor.dealer.seenQty') : t('floor.dealer.soldQty')} value={qty} onChange={setQty} numeric testid="dealer-qty" suffix={t('floor.uom.piece')} />
            {mode === 'observation' ? (
              <ChoiceGrid
                options={[
                  { value: 'rep_visual' as const, label: t('floor.dealer.sources.rep_visual') },
                  { value: 'count' as const, label: t('floor.dealer.sources.count') },
                  { value: 'self_report' as const, label: t('floor.dealer.sources.self_report') },
                ]}
                value={source}
                onChange={setSource}
                label={t('floor.dealer.source')}
                columns={3}
              />
            ) : null}
            <BigButton onClick={() => void submit()} disabled={busy || amount === null || (mode === 'sale' && amount <= 0)} data-testid="dealer-submit">
              {busy ? t('floor.common.sending') : t('app.save')}
            </BigButton>
          </div>
        </Card>
      ) : null}

      {consignment ? (
        <BigButton tone="ghost" onClick={() => void startCount()} disabled={busy} data-testid="dealer-count">
          {t('floor.dealer.startCount')}
        </BigButton>
      ) : null}
    </div>
  );
}
