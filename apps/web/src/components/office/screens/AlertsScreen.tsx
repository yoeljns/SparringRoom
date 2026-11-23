'use client';

import Link from 'next/link';
import { useState } from 'react';
import { parseServerMessage, rows, rpc, type Row } from '@/lib/data/office-db';
import { loadDigest } from '@/lib/notify/digest-fallback';
import { alertTitle, payloadLine, renderDigest } from '@/lib/notify/render';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { DataTable, type Column } from '../DataTable';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { T } from '../i18n';
import { useLookups, withLookups } from '../lookups';
import { Badge, Button, Card, Drawer, Json, Loading, Notice, Select, Tabs } from '../ui';

function AlertList() {
  const lk = useLookups(['user']);
  const [show, setShow] = useState('open');
  const [severity, setSeverity] = useState('');
  const [openId, setOpenId] = useUrlParam('id');
  const list = useLoad(
    () => rows('alert', (q) => {
      if (show === 'open') q = q.is('acked_at', null);
      if (show === 'realtime') q = q.eq('realtime', true);
      if (severity) q = q.eq('severity', severity);
      return q.order('created_at', { ascending: false }).limit(500);
    }),
    [show, severity],
  );
  const act = useAction();
  const open = openId ? (list.data ?? []).find((a) => a.id === openId) : null;
  return (
    <>
      <Notice>{act.error}</Notice>
      <DataTable
        testId="alert-list"
        rows={lk.ready ? list.data : undefined}
        loading={list.loading}
        error={list.error}
        empty={T('alerts.empty')}
        onRowClick={(r) => setOpenId(String(r.id))}
        toolbar={
          <>
            <div className="w-48"><Select value={show} onChange={(v) => setShow(v || 'all')} placeholder={null} options={['open', 'realtime', 'all'].map((x) => ({ value: x, label: T(`alerts.show.${x}`) }))} /></div>
            <div className="w-40"><Select value={severity} onChange={setSeverity} placeholder={T('alerts.allSeverities')} options={['info', 'warning', 'critical'].map((x) => ({ value: x, label: T(`alerts.sev.${x}`) }))} /></div>
          </>
        }
        columns={withLookups([
          { key: 'created_at', type: 'datetime' },
          { key: 'severity', render: (r) => <Badge tone={r.severity === 'critical' ? 'bad' : r.severity === 'warning' ? 'warn' : 'mute'}>{T(`alerts.sev.${r.severity}`)}</Badge>, text: (r) => r.severity },
          { key: 'realtime', render: (r) => (r.realtime ? <Badge tone="dark">{T('alerts.realtime')}</Badge> : <Badge>{T('alerts.digest')}</Badge>), text: (r) => (r.realtime ? 1 : 0) },
          { key: 'rule', render: (r) => alertTitle(r.rule), text: (r) => alertTitle(r.rule) },
          { key: 'payload', label: T('alerts.detail'), render: (r) => <span className="text-xs">{payloadLine(r.payload)}</span>, text: (r) => payloadLine(r.payload) },
          { key: 'sent_at', type: 'datetime' }, { key: 'acked_by', lookup: 'user' } as Column, { key: 'acked_at', type: 'datetime' },
        ], lk)}
        actions={(r) => (r.acked_at ? null : <AckButton row={r} onDone={list.reload} run={act.run} busy={act.busy} />)}
      />
      {open ? (
        <Drawer title={alertTitle(open.rule)} onClose={() => setOpenId('')}>
          <p className="text-sm">{payloadLine(open.payload)}</p>
          {open.entity_type ? <p className="text-sm text-muted">{open.entity_type} · <code>{open.entity_id}</code></p> : null}
          <Json value={open.payload} />
        </Drawer>
      ) : null}
    </>
  );
}

function AckButton({ row, onDone, run, busy }: { row: Row; onDone: () => void; run: <X>(fn: () => Promise<X>) => Promise<X | undefined>; busy: boolean }) {
  return (
    <Button small variant="ghost" disabled={busy} data-testid="ack-alert" onClick={() => void run(async () => { await rpc('rpc_alert_ack', { p_id: row.id }); onDone(); })}>{T('alerts.ack')}</Button>
  );
}

function DigestPreview() {
  const digest = useLoad(async () => {
    const res = await loadDigest(getBrowserSupabase());
    if (res.error || !res.data) throw parseServerMessage(res.error);
    return res;
  }, []);
  if (digest.error) return <Notice>{digest.error}</Notice>;
  if (!digest.data) return <Loading />;
  const rendered = renderDigest(digest.data.data, '');
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card title={T('alerts.digestTitle')}>
        <p className="mb-3 text-sm text-muted">{T('alerts.digestHelp')}</p>
        {digest.data.fallback ? <div className="mb-3"><Notice tone="warn">{T('alerts.digestFallback')}</Notice></div> : null}
        <div className="rounded-md border border-line p-4" data-testid="digest-preview">
          <h4 className="border-b-2 border-brand pb-2 text-base font-bold">{rendered.subject}</h4>
          {rendered.sections.map((s) => (
            <div key={s.key} className="mt-3">
              <Link href={s.path} className={`text-sm font-bold underline ${s.flagged ? 'text-brand' : 'text-ink'}`}>{s.title}</Link>
              <ul className="ml-5 list-disc text-sm">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          ))}
        </div>
      </Card>
      <Card title={T('alerts.digestRaw')}><Json value={digest.data.data} /></Card>
    </div>
  );
}

export function AlertsScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'list', label: T('alerts.tabs.list'), render: () => <AlertList /> },
        { id: 'digest', label: T('alerts.tabs.digest'), render: () => <DigestPreview /> },
      ]}
    />
  );
}

