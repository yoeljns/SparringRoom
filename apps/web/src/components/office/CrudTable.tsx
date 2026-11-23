'use client';

import { useState, type ReactNode } from 'react';
import type { Role } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { remove, rows, upsert, type Row } from '@/lib/data/office-db';
import { DataTable } from './DataTable';
import { FormModal, type FieldDef } from './Form';
import { useAction, useLoad } from './hooks';
import { T } from './i18n';
import { invalidateLookup, useLookups, withLookups, type LkColumn, type LookupName } from './lookups';
import { Button, Modal, Notice } from './ui';

export const MASTER_ROLES: Role[] = ['owner', 'ops_manager', 'planner'];

export interface CrudConfig {
  table: string;
  columns: LkColumn[];
  fields: FieldDef[];
  order?: string;
  ascending?: boolean;
  /** Fixed equality filter, also written into new rows. */
  filter?: Row;
  defaults?: Row;
  lookups?: LookupName[];
  /** Roles that may edit (mirrors table_permission; the database decides). */
  roles?: Role[];
  deletable?: boolean;
  rowActions?: (row: Row, reload: () => void, mayEdit: boolean) => ReactNode;
  onRowClick?: (row: Row) => void;
  toolbar?: (reload: () => void, mayEdit: boolean) => ReactNode;
  /** Adjust the validated form data before rpc_upsert. */
  prepare?: (data: Row, existing: Row | null) => Row;
  addLabel?: string;
  limit?: number;
  empty?: string;
}

/** List + create / edit form for one master table, written through rpc_upsert. */
export function CrudTable({ config, version = 0 }: { config: CrudConfig; version?: number }) {
  const { role } = useProfile();
  const mayEdit = !!role && (config.roles ?? MASTER_ROLES).includes(role);
  const [lkVersion, setLkVersion] = useState(0);
  const lk = useLookups(config.lookups ?? [], lkVersion + version);
  const filterKey = JSON.stringify(config.filter ?? {});
  const list = useLoad(
    () => rows(config.table, (q) => {
      for (const [k, v] of Object.entries(config.filter ?? {})) q = q.eq(k, v);
      return q.order(config.order ?? 'created_at', { ascending: config.ascending ?? true }).limit(config.limit ?? 2000);
    }),
    [config.table, filterKey, version],
  );
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const del = useAction();
  const reload = () => {
    invalidateLookup(config.table);
    setLkVersion((n) => n + 1);
    list.reload();
  };
  const existing = editing && editing !== 'new' ? editing : null;

  return (
    <div data-crud={config.table}>
      <DataTable
        rows={list.data}
        columns={withLookups(config.columns, lk)}
        loading={list.loading}
        error={list.error}
        empty={config.empty}
        onRowClick={config.onRowClick}
        toolbar={
          <>
            {config.toolbar?.(reload, mayEdit)}
            {mayEdit ? <Button variant="primary" onClick={() => setEditing('new')} data-testid={`add-${config.table}`}>{config.addLabel ?? T('c.add')}</Button> : null}
          </>
        }
        actions={(row) => (
          <>
            {config.rowActions?.(row, reload, mayEdit)}
            {mayEdit ? <Button small variant="ghost" onClick={() => setEditing(row)}>{T('c.edit')}</Button> : null}
            {mayEdit && config.deletable ? <Button small variant="danger" onClick={() => setDeleting(row)}>{T('c.delete')}</Button> : null}
          </>
        )}
      />
      {editing ? (
        <FormModal
          title={existing ? T('c.editTitle') : T('c.addTitle')}
          fields={config.fields}
          initial={existing ?? config.defaults ?? null}
          lookups={lk}
          editing={!!existing}
          onClose={() => setEditing(null)}
          onSubmit={async (data) => {
            let row: Row = { ...(config.filter ?? {}), ...data };
            if (existing) row.id = existing.id;
            if (config.prepare) row = config.prepare(row, existing);
            await upsert(config.table, row);
            setEditing(null);
            reload();
          }}
        />
      ) : null}
      {deleting ? (
        <Modal
          title={T('c.deleteTitle')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>{T('c.cancel')}</Button>
              <Button variant="danger" disabled={del.busy} onClick={() => void del.run(async () => { await remove(config.table, String(deleting.id)); setDeleting(null); reload(); })}>{T('c.delete')}</Button>
            </>
          }
        >
          <p className="text-sm">{T('c.deleteConfirm')}</p>
          <Notice>{del.error}</Notice>
        </Modal>
      ) : null}
    </div>
  );
}
