'use client';

import { useState } from 'react';
import { rpc, type Row } from '@/lib/data/office-db';
import { CrudTable } from '../CrudTable';
import { FormModal } from '../Form';
import { useAction } from '../hooks';
import { E, T } from '../i18n';
import { Button, Card, Drawer, Notice, Tabs } from '../ui';

function StateButtons({ row, states, onSet }: { row: Row; states: string[]; onSet: (state: string) => Promise<void> }) {
  const act = useAction();
  return (
    <>
      {states.map((s) => (
        <Button key={s} small variant={s === 'cancelled' ? 'danger' : 'ghost'} disabled={act.busy} data-state-action={s} onClick={() => void act.run(() => onSet(s))}>{T('supply.setState', { s: E(s) })}</Button>
      ))}
      {act.error ? <span className="max-w-48 truncate text-xs text-brand" title={act.error}>{act.error}</span> : null}
      <span className="hidden">{row.id}</span>
    </>
  );
}

const PO_NEXT: Record<string, string[]> = { draft: ['ordered', 'cancelled'], ordered: ['confirmed', 'cancelled'], confirmed: ['cancelled'] };
const PR_NEXT: Record<string, string[]> = { draft: ['planned', 'cancelled'], planned: ['in_progress', 'cancelled'], in_progress: ['cancelled'] };

function PurchaseOrders() {
  const [open, setOpen] = useState<Row | null>(null);
  const [confirming, setConfirming] = useState<{ row: Row; reload: () => void } | null>(null);
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('supply.poHelp')}</p>
      <CrudTable
        config={{
          table: 'purchase_order', order: 'created_at', ascending: false, lookups: ['party', 'supplier_lane'],
          addLabel: T('supply.newPo'), empty: T('supply.noPo'),
          onRowClick: setOpen,
          columns: [
            { key: 'po_no', type: 'mono' }, { key: 'supplier_id', label: T('supply.supplier'), lookup: 'party' }, { key: 'state', type: 'badge' }, { key: 'ordered_at', type: 'datetime' },
            { key: 'promised_date', type: 'date' }, { key: 'confirmed_date', type: 'date' }, { key: 'logo_doc_no' }, { key: 'note' },
          ],
          fields: [
            { key: 'supplier_id', label: T('supply.supplier'), type: 'lookup', lookup: 'party', lookupFilter: (p) => p.type === 'supplier', required: true },
            { key: 'supplier_lane_id', type: 'lookup', lookup: 'supplier_lane' },
            { key: 'promised_date', type: 'date' }, { key: 'logo_doc_no' }, { key: 'note', type: 'textarea' },
          ],
          rowActions: (row, reload, mayEdit) => (mayEdit ? (
            <StateButtons row={row} states={PO_NEXT[row.state] ?? []} onSet={async (s) => {
              if (s === 'confirmed') return setConfirming({ row, reload });
              await rpc('rpc_po_set_state', { p_po: row.id, p_state: s });
              reload();
            }} />
          ) : null),
        }}
      />
      {open ? (
        <Drawer wide title={`${T('supply.po')} ${open.po_no}`} onClose={() => setOpen(null)}>
          <Card title={T('supply.poLines')}>
            <p className="mb-3 text-sm text-muted">{T('supply.datesHelp')}</p>
            <CrudTable
              config={{
                table: 'po_line', filter: { po_id: open.id }, order: 'line_no', lookups: ['item'], deletable: true, addLabel: T('supply.addLine'),
                columns: [
                  { key: 'line_no', type: 'int' }, { key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'qty', type: 'num' }, { key: 'received_qty', type: 'num' },
                  { key: 'promised_date', type: 'date' }, { key: 'confirmed_date', type: 'date' }, { key: 'first_receipt_at', type: 'datetime' }, { key: 'qc_released_at', type: 'datetime' }, { key: 'state', type: 'badge' },
                ],
                fields: [
                  { key: 'line_no', type: 'int', required: true, min: 1 }, { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true },
                  { key: 'qty', type: 'number', required: true, min: 0.001, hint: T('c.baseUnits') }, { key: 'promised_date', type: 'date' }, { key: 'confirmed_date', type: 'date' },
                ],
              }}
            />
          </Card>
        </Drawer>
      ) : null}
      {confirming ? (
        <FormModal
          title={T('supply.confirmPo')}
          fields={[{ key: 'confirmed_date', type: 'date', required: true }]}
          initial={{ confirmed_date: confirming.row.promised_date }}
          onClose={() => setConfirming(null)}
          onSubmit={async (d) => {
            await rpc('rpc_po_set_state', { p_po: confirming.row.id, p_state: 'confirmed', p_confirmed: d.confirmed_date });
            confirming.reload();
            setConfirming(null);
          }}
        >
          <Notice tone="mute">{T('supply.confirmHelp')}</Notice>
        </FormModal>
      ) : null}
    </>
  );
}

function ProductionOrders() {
  return (
    <CrudTable
      config={{
        table: 'production_order', order: 'created_at', ascending: false, lookups: ['item', 'lot'], addLabel: T('supply.newProduction'), empty: T('supply.noProduction'),
        columns: [
          { key: 'order_no', type: 'mono' }, { key: 'item_id', label: T('c.item'), lookup: 'item' }, { key: 'qty', type: 'num' }, { key: 'received_qty', type: 'num' }, { key: 'line' }, { key: 'state', type: 'badge' },
          { key: 'planned_start', type: 'date' }, { key: 'planned_finish', type: 'date' }, { key: 'actual_finish', type: 'date' }, { key: 'qc_released_at', type: 'datetime' }, { key: 'lot_id', label: T('stock.lot'), lookup: 'lot' },
        ],
        fields: [
          { key: 'item_id', label: T('c.item'), type: 'lookup', lookup: 'item', required: true, lookupFilter: (i) => !!i.production_line },
          { key: 'qty', type: 'number', required: true, min: 0.001, hint: T('c.baseUnits') }, { key: 'line' }, { key: 'planned_start', type: 'date' }, { key: 'planned_finish', type: 'date' }, { key: 'note', type: 'textarea' },
        ],
        rowActions: (row, reload, mayEdit) => (mayEdit ? (
          <StateButtons row={row} states={PR_NEXT[row.state] ?? []} onSet={async (s) => { await rpc('rpc_production_set_state', { p_id: row.id, p_state: s }); reload(); }} />
        ) : null),
      }}
    />
  );
}

function Inbound() {
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <>
      <CrudTable
        config={{
          table: 'inbound_shipment', order: 'eta', ascending: false, addLabel: T('supply.newInbound'), empty: T('supply.noInbound'), onRowClick: setOpen,
          columns: [{ key: 'vehicle_ref' }, { key: 'state', type: 'badge' }, { key: 'etd', type: 'date' }, { key: 'eta', type: 'date' }, { key: 'arrived_at', type: 'datetime' }],
          fields: [
            { key: 'vehicle_ref' }, { key: 'state', type: 'select', options: ['planned', 'in_transit', 'arrived', 'cancelled'], required: true }, { key: 'etd', type: 'date' }, { key: 'eta', type: 'date' },
          ],
          defaults: { state: 'planned' },
        }}
      />
      {open ? (
        <Drawer wide title={`${T('supply.inbound')} ${open.vehicle_ref ?? ''}`} onClose={() => setOpen(null)}>
          <CrudTable
            config={{
              table: 'inbound_line', filter: { inbound_shipment_id: open.id }, lookups: ['po_line', 'purchase_order', 'item'], deletable: true,
              columns: [{ key: 'po_line_id', lookup: 'po_line' }, { key: 'qty', type: 'num' }],
              fields: [{ key: 'po_line_id', type: 'lookup', lookup: 'po_line', required: true }, { key: 'qty', type: 'number', required: true, min: 0.001 }],
            }}
          />
        </Drawer>
      ) : null}
    </>
  );
}

function Capacity() {
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('supply.capacityHelp')}</p>
      <CrudTable
        config={{
          table: 'capacity_calendar', order: 'date', deletable: true, limit: 1000,
          columns: [{ key: 'line' }, { key: 'date', type: 'date' }, { key: 'pallets_per_day', type: 'num' }],
          fields: [{ key: 'line', required: true }, { key: 'date', type: 'date', required: true }, { key: 'pallets_per_day', type: 'number', required: true, min: 0 }],
        }}
      />
    </>
  );
}

export function SupplyScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'po', label: T('supply.tabs.po'), render: () => <PurchaseOrders /> },
        { id: 'production', label: T('supply.tabs.production'), render: () => <ProductionOrders /> },
        { id: 'inbound', label: T('supply.tabs.inbound'), render: () => <Inbound /> },
        { id: 'capacity', label: T('supply.tabs.capacity'), render: () => <Capacity /> },
      ]}
    />
  );
}
