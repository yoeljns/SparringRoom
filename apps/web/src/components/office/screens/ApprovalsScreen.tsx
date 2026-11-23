'use client';

import { useState } from 'react';
import { useProfile } from '@/lib/auth/profile-context';
import { rows, rpc, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from '../DataTable';
import { FormModal } from '../Form';
import { useLoad } from '../hooks';
import { E, T } from '../i18n';
import { useLookups, withLookups } from '../lookups';
import { Badge, Button, Card, Drawer, Facts, Json, Notice, StatusBadge, Tabs } from '../ui';

function Inbox({ history }: { history: boolean }) {
  const { profile, role } = useProfile();
  const lk = useLookups(['user', 'item', 'party']);
  const rules = useLoad(() => rows('approval_rule'), []);
  const list = useLoad(
    () => rows('approval_request', (q) => (history ? q.neq('state', 'pending') : q.eq('state', 'pending')).order('created_at', { ascending: false }).limit(500)),
    [history],
  );
  const [open, setOpen] = useState<Row | null>(null);
  const [deciding, setDeciding] = useState<{ row: Row; approve: boolean } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ruleOf = (type: string) => (rules.data ?? []).find((r) => r.type === type);
  const approvers = (type: string): string[] => ruleOf(type)?.approver_roles ?? [];
  const own = (r: Row) => r.requested_by === profile?.id;
  const mayDecide = (r: Row) => !!role && approvers(r.type).includes(role) && !own(r);

  return (
    <>
      {done ? <div className="mb-3"><Notice tone="ok">{done}</Notice></div> : null}
      <DataTable
        testId={history ? 'approval-history' : 'approval-inbox'}
        rows={lk.ready && rules.data ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={history ? T('appr.noHistory') : T('appr.noPending')}
        onRowClick={setOpen}
        columns={withLookups([
          { key: 'created_at', type: 'datetime' }, { key: 'type', type: 'badge' }, { key: 'state', type: 'badge' }, { key: 'reason' },
          { key: 'requested_by', lookup: 'user' } as Column,
          { key: 'approvers', label: T('appr.whoMay'), render: (r) => approvers(r.type).map((a) => E(a)).join(', '), text: (r) => approvers(r.type).join(' ') },
          ...(history ? [{ key: 'approved_by', lookup: 'user' } as Column, { key: 'decided_at', type: 'datetime' } as Column, { key: 'decision_note' } as Column] : []),
        ], lk)}
        actions={history ? undefined : (r) => (
          own(r) ? <Badge tone="warn">{T('appr.ownRequest')}</Badge> : mayDecide(r) ? (
            <>
              <Button small variant="primary" data-testid="approve" onClick={() => setDeciding({ row: r, approve: true })}>{T('appr.approve')}</Button>
              <Button small variant="danger" onClick={() => setDeciding({ row: r, approve: false })}>{T('appr.reject')}</Button>
            </>
          ) : <Badge>{T('appr.notYours')}</Badge>
        )}
      />
      {open ? (
        <Drawer title={`${E(open.type)} · ${E(open.state)}`} onClose={() => setOpen(null)}>
          <Facts items={[
            [T('c.state'), <StatusBadge key="s" value={open.state} />], [T('appr.requestedBy'), lk.label('user', open.requested_by)], [T('appr.whoMay'), approvers(open.type).map((a) => E(a)).join(', ')],
            [T('c.reason'), open.reason ?? '—'], [T('appr.decidedBy'), lk.label('user', open.approved_by)], [T('appr.note'), open.decision_note ?? '—'],
          ]} />
          <p className="text-sm text-muted">{ruleOf(open.type)?.description}</p>
          {open.type === 'param_publish' && Array.isArray(open.payload?.rows) ? (
            <Card title={T('appr.paramRows')}>
              <ul className="text-sm">{(open.payload.rows as Row[]).map((r, i) => <li key={i}><code>{r.param}</code> · {E(r.scope_type ?? 'global')} {r.scope_id && r.scope_id !== '*' ? String(r.scope_id).slice(0, 8) : ''} → <strong>{JSON.stringify(r.value)}</strong></li>)}</ul>
            </Card>
          ) : null}
          <Json value={open.payload} />
        </Drawer>
      ) : null}
      {deciding ? (
        <FormModal
          title={deciding.approve ? T('appr.approveTitle') : T('appr.rejectTitle')}
          fields={[{ key: 'note', label: T('appr.note'), type: 'textarea', required: !deciding.approve }]}
          submitLabel={deciding.approve ? T('appr.approve') : T('appr.reject')}
          onClose={() => setDeciding(null)}
          onSubmit={async (d) => {
            const res = await rpc<Row>('rpc_decide_approval', { p_id: deciding.row.id, p_approve: deciding.approve, p_note: d.note });
            setDone(T('appr.decided', { state: E(res?.state) }));
            setDeciding(null);
            list.reload();
          }}
        >
          <p className="text-sm text-muted">{E(deciding.row.type)} · {deciding.row.reason}</p>
        </FormModal>
      ) : null}
    </>
  );
}

function Rules() {
  const rules = useLoad(() => rows('approval_rule', (q) => q.order('type')), []);
  return (
    <DataTable search={false} rows={rules.data} loading={rules.loading} error={rules.error} rowKey={(r) => String(r.type)} columns={[
      { key: 'type', type: 'badge' }, { key: 'description' },
      { key: 'requester_roles', render: (r) => (r.requester_roles ? (r.requester_roles as string[]).map((x) => E(x)).join(', ') : T('appr.anyone')) },
      { key: 'approver_roles', render: (r) => (r.approver_roles as string[]).map((x) => E(x)).join(', ') },
    ]} />
  );
}

export function ApprovalsScreen() {
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('appr.help')}</p>
      <Tabs
        tabs={[
          { id: 'pending', label: T('appr.tabs.pending'), render: () => <Inbox history={false} /> },
          { id: 'history', label: T('appr.tabs.history'), render: () => <Inbox history /> },
          { id: 'rules', label: T('appr.tabs.rules'), render: () => <Rules /> },
        ]}
      />
    </>
  );
}
