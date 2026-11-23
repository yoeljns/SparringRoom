'use client';

import Link from 'next/link';
import { useCallback, useMemo } from 'react';
import { canSee } from '@dayson/domain';
import { EmptyState, Loading, OfflineNotice, RefreshButton, SectionTitle } from '@/components/floor/ui';
import { Icon, type IconName } from '@/components/icons';
import { formatIsoDate, t, tDynamic } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import { listCountTasks, listTasks, type CountTaskRow, type TaskRow } from '@/lib/data/floor-read';
import { fmtQty } from '@/lib/floor/format';
import { useOutbox } from '@/lib/floor/outbox/react';
import { useCachedQuery } from '@/lib/floor/use-cached-query';

/** Group order on the screen; unknown types go last. */
const TYPE_ORDER = ['pick', 'load', 'putaway', 'replenish', 'transfer', 'consolidate', 'receive', 'qc', 'count', 'count_request', 'rotate_recall'];

const TYPE_ICON: Record<string, IconName> = {
  pick: 'pick',
  load: 'load',
  putaway: 'putaway',
  replenish: 'transfer',
  transfer: 'transfer',
  consolidate: 'transfer',
  receive: 'receive',
  qc: 'qc',
  count: 'count',
  count_request: 'dealers',
  rotate_recall: 'dealers',
};

interface TaskItem {
  key: string;
  type: string;
  priority: number;
  title: string;
  detail: string;
  href: string | null;
  badge?: string;
}

function q(params: Record<string, string | null | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) usp.set(k, v);
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** Which screen completes this task, pre-filled. */
export function taskHref(task: TaskRow): string | null {
  switch (task.type) {
    case 'pick':
      return `/floor/pick${q({ shipment: task.shipment_id, task: task.id })}`;
    case 'load':
      return `/floor/load${q({ shipment: task.shipment_id })}`;
    case 'putaway':
      return `/floor/putaway${q({ pallet: task.pallet_serial, task: task.id })}`;
    case 'replenish':
    case 'transfer':
    case 'consolidate':
      return `/floor/transfer${q({ task: task.id, from: task.location_code, to: task.to_location_code, pallet: task.pallet_serial })}`;
    case 'receive':
      return '/floor/receive';
    case 'qc':
      return `/floor/qc${q({ lot: task.lot_id })}`;
    case 'count_request':
    case 'rotate_recall':
      return `/floor/dealer${q({ party: task.party_id, item: task.item_id })}`;
    default:
      return null;
  }
}

function describe(task: TaskRow): TaskItem {
  const parts: string[] = [];
  if (task.sku) parts.push(task.sku);
  if (task.lot_no) parts.push(`${t('scan.field.lot')} ${task.lot_no}`);
  if (task.expiry_date) parts.push(`${t('floor.common.expiryShort')} ${formatIsoDate(task.expiry_date)}`);
  if (task.pallets) parts.push(t('floor.common.pallets', { n: fmtQty(task.pallets) }));
  let title = task.location_code ?? task.pallet_serial ?? task.sku ?? task.party_name ?? '—';
  if (task.type === 'pick') title = `${task.location_code ?? '—'} → ${task.shipment_no ?? ''}`;
  else if (task.to_location_code) title = `${task.location_code ?? '—'} → ${task.to_location_code}`;
  else if (task.type === 'qc') title = task.lot_no ? `${t('scan.field.lot')} ${task.lot_no}` : (task.sku ?? '—');
  else if (task.party_name && !task.location_code) title = task.party_name;
  if (task.party_name && task.type === 'pick') parts.push(task.party_name);
  return {
    key: task.id,
    type: task.type,
    priority: task.priority,
    title,
    detail: parts.join(' · '),
    href: taskHref(task),
    badge: task.state === 'in_progress' ? t('floor.tasks.inProgress') : undefined,
  };
}

function describeCount(task: CountTaskRow): TaskItem {
  return {
    key: `count-${task.id}`,
    type: 'count',
    priority: task.state === 'recount' ? 1 : 3,
    title: task.location_code,
    detail: [task.sku, task.lot_no ? `${t('scan.field.lot')} ${task.lot_no}` : null, tDynamic(`floor.count.trigger.${task.trigger}`, 'floor.count.trigger.other')]
      .filter(Boolean)
      .join(' · '),
    href: `/floor/count?task=${task.id}`,
    badge: task.state === 'recount' ? t('floor.count.recount') : undefined,
  };
}

/** Görevlerim: the user's open tasks by priority, grouped by type, with the outbox counter. */
export function TasksScreen() {
  const { profile, role } = useProfile();
  const { queued, rejected } = useOutbox();
  const canCount = canSee(role, 'floor.count');

  const fetcher = useCallback(
    async (sb: Parameters<typeof listTasks>[0]) => {
      const [tasks, counts] = await Promise.all([listTasks(sb), canCount ? listCountTasks(sb) : Promise.resolve([] as CountTaskRow[])]);
      return { tasks, counts };
    },
    [canCount],
  );
  const query = useCachedQuery(role ? 'tasks' : null, fetcher);

  const groups = useMemo(() => {
    const data = query.data;
    if (!data) return [];
    const seeAll = role === 'owner' || role === 'ops_manager';
    const mine = data.tasks.filter((task) => {
      if (task.assigned_to) return task.assigned_to === profile?.id || seeAll;
      return seeAll || !task.assigned_role || task.assigned_role === role;
    });
    const counts = data.counts.filter((c) => !c.assigned_to || c.assigned_to === profile?.id || seeAll);
    const items = [...mine.map(describe), ...counts.map(describeCount)].sort((a, b) => a.priority - b.priority);
    const byType = new Map<string, TaskItem[]>();
    for (const item of items) byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
    const rank = (type: string) => (TYPE_ORDER.indexOf(type) === -1 ? TYPE_ORDER.length : TYPE_ORDER.indexOf(type));
    return [...byType.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [query.data, role, profile?.id]);

  const total = groups.reduce((n, [, items]) => n + items.length, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-stretch gap-2">
        <Link
          href="/floor/outbox"
          data-testid="tasks-outbox"
          className={`flex min-h-16 flex-1 items-center gap-3 rounded-xl border-2 px-3 ${rejected > 0 ? 'border-brand bg-brand-soft' : 'border-ink bg-paper'}`}
        >
          <Icon name="outbox" size={28} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-sm font-semibold uppercase tracking-wide text-muted">{t('outbox.title')}</span>
            <span className="block text-lg font-extrabold">
              {t('floor.tasks.outbox', { queued, rejected })}
            </span>
          </span>
        </Link>
        <RefreshButton onClick={query.reload} busy={query.loading} />
      </div>

      <OfflineNotice stale={query.stale} fetchedAt={query.fetchedAt} />
      {query.error ? <p className="px-1 text-base font-semibold text-brand-dark">{query.error}</p> : null}

      {query.loading && !query.data ? (
        <Loading />
      ) : total === 0 ? (
        <EmptyState>{query.data ? t('floor.tasks.empty') : t('floor.common.offlineNoData')}</EmptyState>
      ) : (
        groups.map(([type, items]) => (
          <section key={type} className="flex flex-col gap-2" data-testid={`task-group-${type}`}>
            <SectionTitle count={items.length}>{tDynamic(`floor.tasks.type.${type}`, 'floor.tasks.type.other')}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {items.map((item) => {
                const body = (
                  <>
                    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${item.priority <= 1 ? 'bg-brand text-paper' : 'bg-ink text-paper'}`}>
                      <Icon name={TYPE_ICON[item.type] ?? 'tasks'} size={24} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-lg font-extrabold leading-tight">{item.title}</span>
                      <span className="block truncate text-sm font-medium text-ink-soft">{item.detail}</span>
                    </span>
                    {item.badge ? <span className="shrink-0 rounded-full bg-warn-soft px-2 py-1 text-xs font-bold text-warn">{item.badge}</span> : null}
                    {item.href ? <Icon name="chevronRight" size={24} className="shrink-0 text-muted" /> : null}
                  </>
                );
                const cls = 'flex min-h-16 items-center gap-3 rounded-xl border-2 border-line bg-paper px-3 py-2 active:bg-surface';
                return (
                  <li key={item.key}>
                    {item.href ? (
                      <Link href={item.href} className={cls} data-testid={`task-${item.type}`}>
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
