'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { can } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { newUuid, rows, rpcReturning, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from './DataTable';
import { ReasonModal } from './Form';
import { useLoad } from './hooks';
import { E, fNum, T } from './i18n';
import { Badge, Button, Drawer, Notice } from './ui';

/** The dimensions a stock number was summed over. */
export interface LedgerDims {
  item_id?: string | null;
  lot_id?: string | null;
  location_id?: string | null;
  stock_status?: string | null;
  owner_id?: string | null;
  pallet_id?: string | null;
  txn_id?: string | null;
  /** Shown in the drawer title. */
  title?: string;
}

const Ctx = createContext<((dims: LedgerDims) => void) | null>(null);

export function useLedger(): (dims: LedgerDims) => void {
  return useContext(Ctx) ?? (() => {});
}

const FILTER_KEYS = ['item_id', 'lot_id', 'location_id', 'stock_status', 'owner_id', 'pallet_id', 'txn_id'] as const;

export async function loadMoves(dims: LedgerDims, limit = 500): Promise<Row[]> {
  const list = await rows('v_stock_moves', (q) => {
    for (const k of FILTER_KEYS) if (dims[k]) q = q.eq(k, dims[k]);
    return q.order('event_at', { ascending: false }).limit(limit);
  });
  // Without a location the virtual counter-entries would cancel every move out.
  return dims.location_id || dims.txn_id ? list : list.filter((m) => !String(m.location_code ?? '').startsWith('V-'));
}

export const MOVE_COLUMNS: Column[] = [
  { key: 'event_at', type: 'datetime' },
  { key: 'txn_type', render: (r) => <Badge tone={r.txn_type === 'reversal' ? 'bad' : 'mute'}>{E(r.txn_type)}</Badge>, text: (r) => E(r.txn_type) },
  { key: 'sku' },
  { key: 'lot_no' },
  { key: 'location_code' },
  { key: 'stock_status', type: 'badge' },
  { key: 'qty_base', type: 'num', render: (r) => <span className={Number(r.qty_base) < 0 ? 'text-brand' : 'text-ok'}>{Number(r.qty_base) > 0 ? '+' : ''}{fNum(r.qty_base)}</span> },
  { key: 'scan_method', type: 'badge' },
  { key: 'user_name' },
  { key: 'reason_code' },
  { key: 'ref_doc', label: undefined, render: (r) => (r.ref_doc_type ? `${E(r.ref_doc_type)} ${String(r.ref_doc_id ?? '').slice(0, 8)}` : '—'), text: (r) => `${r.ref_doc_type ?? ''} ${r.ref_doc_id ?? ''}` },
];

/** Ledger rows with the reversal action (ops_manager / owner). */
export function MovesTable({ moves, loading, error, onChanged, toolbar }: { moves: Row[] | undefined; loading?: boolean; error?: string | null; onChanged: () => void; toolbar?: ReactNode }) {
  const { role } = useProfile();
  const mayReverse = can(role, 'stock.adjust.approve');
  const [target, setTarget] = useState<Row | null>(null);
  const reversed = useMemo(() => new Set((moves ?? []).map((m) => m.reverses_txn_id).filter(Boolean)), [moves]);
  return (
    <>
      <DataTable
        testId="ledger-rows"
        rows={moves}
        columns={MOVE_COLUMNS}
        loading={loading}
        error={error}
        toolbar={toolbar}
        empty={T('ledger.empty')}
        rowKey={(r) => String(r.id)}
        actions={mayReverse ? (r) => (r.txn_type !== 'reversal' && !reversed.has(r.txn_id) ? <Button small variant="danger" onClick={() => setTarget(r)}>{T('ledger.reverse')}</Button> : null) : undefined}
      />
      {target ? (
        <ReasonModal
          title={T('ledger.reverseTitle')}
          label={T('ledger.reverseReason')}
          confirmLabel={T('ledger.reverse')}
          onClose={() => setTarget(null)}
          onSubmit={async (reason) => {
            await rpcReturning('post_txn', { txn: { txn_type: 'reversal', reverses_txn_id: target.txn_id, reason_code: reason, client_uuid: newUuid(), scan_method: 'manual' } });
            setTarget(null);
            onChanged();
          }}
        >
          <Notice tone="warn">{T('ledger.reverseWarn', { type: E(target.txn_type) })}</Notice>
        </ReasonModal>
      ) : null}
    </>
  );
}

function LedgerDrawer({ dims, onClose }: { dims: LedgerDims; onClose: () => void }) {
  const moves = useLoad(() => loadMoves(dims), [dims]);
  const total = (moves.data ?? []).reduce((s, m) => s + Number(m.qty_base ?? 0), 0);
  return (
    <Drawer wide title={dims.title ? `${T('ledger.title')}: ${dims.title}` : T('ledger.title')} onClose={onClose}>
      <p className="text-sm text-muted">{T('ledger.help')}</p>
      <p className="text-sm">
        {T('ledger.sum')}: <strong className="tabular-nums" data-testid="ledger-sum">{fNum(total)}</strong>
      </p>
      <MovesTable moves={moves.data} loading={moves.loading} error={moves.error} onChanged={moves.reload} />
    </Drawer>
  );
}

/** Lets any stock number on any screen open the ledger rows behind it (spec 13.1). */
export function LedgerProvider({ children }: { children: ReactNode }) {
  const [dims, setDims] = useState<LedgerDims | null>(null);
  const open = useCallback((d: LedgerDims) => setDims(d), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {dims ? <LedgerDrawer dims={dims} onClose={() => setDims(null)} /> : null}
    </Ctx.Provider>
  );
}

/** A stock quantity that opens its ledger rows. */
export function QtyLink({ value, dims, digits = 3 }: { value: unknown; dims: LedgerDims; digits?: 0 | 2 | 3 }) {
  const open = useLedger();
  return (
    <button
      type="button"
      data-qty-link
      title={T('ledger.open')}
      onClick={(e) => { e.stopPropagation(); open(dims); }}
      className="font-semibold tabular-nums text-ink underline decoration-brand decoration-2 underline-offset-2 hover:text-brand"
    >
      {fNum(value, digits)}
    </button>
  );
}
