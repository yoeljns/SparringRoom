'use client';

import { useState } from 'react';
import { buildLogoFile, LOGO_INBOUND_TYPES, LOGO_OUTBOUND_TYPES, parseLogoFile, sha256Hex, type LogoFileType, type LogoRowInput } from '@dayson/domain';
import { useProfile } from '@/lib/auth/profile-context';
import { downloadTextFile, rows, rpc, uploadText, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from '../DataTable';
import { useAction, useLoad, useUrlParam } from '../hooks';
import { E, errText, fDate, fDateTime, fNum, T } from '../i18n';
import { QtyLink } from '../Ledger';
import { useLookups, withLookups } from '../lookups';
import { Badge, Button, Card, Drawer, Field, Notice, Select, Stat, StatusBadge, Tabs, inputCls } from '../ui';

const EXCHANGE_ROLES = ['finance', 'ops_manager', 'owner'];

interface UploadResult {
  file: string;
  state: string;
  batch_id?: string;
  detail: string[];
}

/** Parse, hash, store the original in logo-in, then rpc_import_batch. */
async function importFile(file: File): Promise<UploadResult> {
  const text = await file.text();
  const parsed = parseLogoFile(file.name, text);
  const hash = await sha256Hex(text);
  if (!parsed.type) {
    // Not even a known file name: nothing the importer could record under a type.
    return { file: file.name, state: 'rejected', detail: parsed.errors.map((e) => `${e.code}: ${e.message}`) };
  }
  let storageNote: string[] = [];
  try {
    await uploadText('logo-in', `${hash.slice(0, 12)}_${file.name}`, text);
  } catch (err) {
    storageNote = [errText(err)];
  }
  // A rejected file is still sent (header only) so the importer records the rejection and alerts.
  const body = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = parsed.header.length ? parsed.header : (body[1] ?? '').split(';').map((x) => x.trim());
  const schema = parsed.schemaVersion ?? (/^#schema=(.+)$/.exec(body[0]?.trim() ?? '')?.[1] ?? '');
  const res = await rpc<Row>('rpc_import_batch', {
    p_file_name: file.name, p_file_hash: hash, p_file_type: parsed.type, p_schema_version: schema, p_header: header, p_rows: parsed.rejected ? [] : parsed.rows,
  });
  const detail = [...storageNote, ...parsed.errors.map((e) => `${e.line ? `${T('recon.line')} ${e.line}: ` : ''}${e.code}${e.column ? ` (${e.column})` : ''}`)];
  if (res.reason) detail.push(String(res.reason));
  if (res.rows !== undefined) detail.push(T('recon.rowsApplied', { n: res.rows }));
  if (typeof res.errors === 'number') detail.push(T('recon.rowErrors', { n: res.errors }));
  return { file: file.name, state: String(res.state), batch_id: res.batch_id, detail };
}

function BatchErrors({ batch, onClose }: { batch: Row; onClose: () => void }) {
  const errs = useLoad(() => rows('import_row_error', (q) => q.eq('batch_id', batch.id).order('row_no').limit(500)), [batch.id]);
  return (
    <Drawer title={batch.file_name} onClose={onClose}>
      <p className="text-sm">{T('c.state')}: <StatusBadge value={batch.state} /> · {T('recon.rows')}: {batch.row_count} · {T('c.errors')}: {batch.error_count}</p>
      {batch.error ? <Notice>{batch.error}</Notice> : null}
      <DataTable search={false} rows={errs.data} loading={errs.loading} error={errs.error} empty={T('recon.noRowErrors')} columns={[{ key: 'row_no', type: 'int' }, { key: 'error' }, { key: 'raw', type: 'json' }]} />
    </Drawer>
  );
}

function Inbound() {
  const { role } = useProfile();
  const may = !!role && EXCHANGE_ROLES.includes(role);
  const lk = useLookups(['user']);
  const history = useLoad(() => rows('import_batch', (q) => q.order('created_at', { ascending: false }).limit(200), 'id,file_name,file_hash,file_type,schema_version,state,row_count,error_count,error,created_at,created_by'), []);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [open, setOpen] = useState<Row | null>(null);
  const act = useAction();
  const onFiles = (files: FileList | null) => void act.run(async () => {
    const out: UploadResult[] = [];
    for (const f of Array.from(files ?? [])) {
      try {
        out.push(await importFile(f));
      } catch (err) {
        out.push({ file: f.name, state: 'rejected', detail: [errText(err)] });
      }
    }
    setResults(out);
    history.reload();
  });
  return (
    <div className="space-y-4">
      <Card title={T('recon.uploadTitle')}>
        <p className="mb-3 text-sm text-muted">{T('recon.uploadHelp', { types: LOGO_INBOUND_TYPES.join(', ') })}</p>
        {may ? <input type="file" multiple accept=".csv,text/csv" data-testid="logo-file" disabled={act.busy} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} className="block text-sm" /> : <Notice tone="mute">{T('c.readOnly')}</Notice>}
        <div className="mt-3 space-y-2" data-testid="upload-results">
          <Notice>{act.error}</Notice>
          {results.map((r, i) => (
            <div key={`${r.file}${i}`} data-upload-state={r.state} className="rounded-md border border-line p-3 text-sm">
              <span className="font-mono text-xs">{r.file}</span> <StatusBadge value={r.state} /> <span className="text-muted">{T(`recon.state.${r.state}`)}</span>
              {r.detail.length ? <ul className="ml-5 mt-1 list-disc text-xs text-ink-soft">{r.detail.map((d, j) => <li key={j}>{d}</li>)}</ul> : null}
            </div>
          ))}
        </div>
      </Card>
      <Card title={T('recon.history')}>
        <DataTable
          testId="import-history"
          rows={lk.ready ? history.data : undefined}
          loading={history.loading}
          error={history.error}
          empty={T('recon.noImports')}
          onRowClick={setOpen}
          columns={withLookups([
            { key: 'created_at', type: 'datetime' }, { key: 'file_name', type: 'mono' }, { key: 'file_type', type: 'badge' }, { key: 'state', type: 'badge' }, { key: 'row_count', type: 'int' }, { key: 'error_count', type: 'int' },
            { key: 'error' }, { key: 'file_hash', type: 'mono', render: (r) => <code className="text-xs">{String(r.file_hash).slice(0, 12)}</code> }, { key: 'created_by', lookup: 'user' } as Column,
          ], lk)}
        />
      </Card>
      {open ? <BatchErrors batch={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function exportText(type: string, period: string, seq: number, payload: Row): string {
  const header: string[] = payload.header ?? [];
  const list: Row[] = payload.rows ?? [];
  // Only contract columns are written; the builder validates every cell.
  const clean = list.map((r) => Object.fromEntries(header.map((h) => [h, r[h] ?? null]))) as LogoRowInput[];
  return buildLogoFile(type as LogoFileType, period, seq, clean).text;
}

function Outbound() {
  const { role } = useProfile();
  const may = !!role && EXCHANGE_ROLES.includes(role);
  const lk = useLookups(['user']);
  const pending = useLoad(() => rows('export_row', (q) => q.is('export_batch_id', null).limit(5000), 'type'), []);
  const batches = useLoad(() => rows('export_batch', (q) => q.order('created_at', { ascending: false }).limit(200)), []);
  const act = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const count = (type: string) => (pending.data ?? []).filter((r) => r.type === type).length;
  const reload = () => { pending.reload(); batches.reload(); };

  const build = (type: string) => void act.run(async () => {
    setMsg(null);
    const res = await rpc<Row>('rpc_export_build', { p_type: type });
    if (res.state === 'empty') return setMsg(T('recon.exportEmpty', { type }));
    const period = new Date().toISOString().slice(0, 10);
    const text = exportText(type, period, 1, res);
    await uploadText('logo-out', String(res.file_name), text);
    downloadTextFile(String(res.file_name), text);
    setMsg(T('recon.exportBuilt', { file: res.file_name, n: (res.rows ?? []).length }));
    reload();
  });
  const download = (b: Row) => void act.run(async () => {
    const res = await rpc<Row>('rpc_export_get', { p_batch: b.id });
    downloadTextFile(String(b.file_name), exportText(b.type, String(b.period), Number(b.seq), res));
  });
  const ack = (b: Row) => void act.run(async () => { await rpc('rpc_export_ack', { p_batch: b.id }); reload(); });

  return (
    <div className="space-y-4">
      <Card title={T('recon.outboundTitle')}>
        <p className="mb-3 text-sm text-muted">{T('recon.outboundHelp')}</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {LOGO_OUTBOUND_TYPES.map((type) => (
            <div key={type} className="rounded-md border border-line p-3" data-export-type={type}>
              <p className="font-mono text-xs">{type}</p>
              <p className="text-sm font-semibold">{T(`recon.out.${type}`)}</p>
              <p className="my-2 text-2xl font-bold tabular-nums">{count(type)}</p>
              <p className="mb-2 text-xs text-muted">{T('recon.pendingRows')}</p>
              {may ? <Button small variant="primary" disabled={act.busy || count(type) === 0} onClick={() => build(type)}>{T('recon.build')}</Button> : null}
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-2"><Notice>{act.error}</Notice>{msg ? <Notice tone="ok">{msg}</Notice> : null}</div>
      </Card>
      <Card title={T('recon.exportHistory')}>
        <DataTable
          rows={lk.ready ? batches.data : undefined}
          loading={batches.loading}
          error={batches.error}
          empty={T('recon.noExports')}
          columns={withLookups([
            { key: 'created_at', type: 'datetime' }, { key: 'file_name', type: 'mono' }, { key: 'type', type: 'badge' }, { key: 'period', type: 'date' }, { key: 'row_count', type: 'int' },
            { key: 'acknowledged_at', render: (r) => (r.acknowledged_at ? fDateTime(r.acknowledged_at) : <Badge tone="warn">{T('recon.notAcked')}</Badge>) }, { key: 'created_by', lookup: 'user' } as Column,
          ], lk)}
          actions={(b) => (
            <>
              <Button small variant="ghost" onClick={() => download(b)}>{T('recon.download')}</Button>
              {may && !b.acknowledged_at ? <Button small variant="ghost" onClick={() => ack(b)}>{T('recon.ack')}</Button> : null}
            </>
          )}
        />
      </Card>
    </div>
  );
}

function Diffs() {
  const { role } = useProfile();
  const may = !!role && ['finance', 'owner', 'ops_manager'].includes(role);
  const [old, setOld] = useUrlParam('old');
  const [cls, setCls] = useState('');
  const [asOf, setAsOf] = useState('');
  const open = useLoad(() => rows('v_recon_open', (q) => q.order('age_hours', { ascending: false }).limit(2000)), []);
  const act = useAction();
  const [result, setResult] = useState<Row | null>(null);
  const list = (open.data ?? []).filter((r) => (!cls || r.class === cls) && (!old || (r.class !== 'timing' && Number(r.age_hours) > 48)));
  const all = open.data ?? [];
  const over48 = all.filter((r) => r.class !== 'timing' && Number(r.age_hours) > 48).length;
  const classes = ['timing', 'mapping', 'missing_doc', 'true_variance'];
  return (
    <div className="space-y-4">
      <Card title={T('recon.runTitle')}>
        <p className="mb-3 text-sm text-muted">{T('recon.runHelp')}</p>
        {may ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={T('recon.asOf')} hint={T('recon.asOfHint')}><input type="date" name="as_of" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
            <Button variant="primary" disabled={act.busy} data-testid="run-recon" onClick={() => void act.run(async () => { setResult(await rpc<Row>('rpc_run_reconciliation', { p_as_of: asOf || null })); open.reload(); })}>{T('recon.run')}</Button>
          </div>
        ) : <Notice tone="mute">{T('c.readOnly')}</Notice>}
        <div className="mt-3"><Notice>{act.error}</Notice></div>
        {result ? <div className="mt-3"><Notice tone="ok"><span data-testid="recon-result">{T('recon.runResult', { date: fDate(result.as_of), open: result.open ?? 0, old: result.unexplained_over_48h ?? 0 })}</span></Notice></div> : null}
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {classes.map((c) => <Stat key={c} label={E(c)} value={fNum(all.filter((r) => r.class === c).length, 0)} hint={T(`recon.classHint.${c}`)} onClick={() => { setCls(c); setOld(''); }} />)}
        <Stat label={T('recon.over48')} value={fNum(over48, 0)} tone={over48 > 0 ? 'bad' : 'ok'} hint={T('recon.target')} onClick={() => { setCls(''); setOld('1'); }} />
      </div>
      <DataTable
        testId="recon-diffs"
        rows={open.data ? list : undefined}
        loading={open.loading}
        error={open.error}
        empty={T('recon.noDiffs')}
        toolbar={
          <>
            <div className="w-48"><Select value={cls} onChange={setCls} placeholder={T('recon.allClasses')} options={classes.map((c) => ({ value: c, label: E(c) }))} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!old} onChange={(e) => setOld(e.target.checked ? '1' : '')} className="h-4 w-4" />{T('recon.onlyOld')}</label>
          </>
        }
        columns={[
          { key: 'class', type: 'badge' }, { key: 'level', type: 'badge' }, { key: 'sku' }, { key: 'item_name' }, { key: 'doc_no', type: 'mono' }, { key: 'doc_side', type: 'badge' },
          { key: 'logo_qty', type: 'num' },
          { key: 'ledger_qty', type: 'num', render: (r) => (r.level === 'item' && r.item_id ? <QtyLink value={r.ledger_qty} dims={{ item_id: r.item_id, title: r.sku }} /> : fNum(r.ledger_qty)) },
          { key: 'diff', type: 'num', render: (r) => <strong className={Number(r.diff) !== 0 ? 'text-brand' : ''}>{fNum(r.diff)}</strong> },
          { key: 'age_hours', type: 'int', render: (r) => <span className={r.class !== 'timing' && Number(r.age_hours) > 48 ? 'font-bold text-brand' : ''}>{fNum(r.age_hours, 0)}</span> },
          { key: 'first_seen_at', type: 'datetime' },
        ]}
      />
    </div>
  );
}

function SignOff() {
  const { role } = useProfile();
  const maySign = role === 'finance' || role === 'owner';
  const lk = useLookups(['user']);
  const runs = useLoad(() => rows('recon_run', (q) => q.order('created_at', { ascending: false }).limit(100)), []);
  const act = useAction();
  return (
    <>
      <p className="mb-3 text-sm text-muted">{T('recon.signHelp')}</p>
      <Notice>{act.error}</Notice>
      <DataTable
        testId="recon-runs"
        rows={lk.ready ? runs.data : undefined}
        loading={runs.loading}
        error={runs.error}
        empty={T('recon.noRuns')}
        columns={withLookups([
          { key: 'run_date', type: 'date' }, { key: 'cutoff_at', type: 'datetime' }, { key: 'kind', type: 'badge' },
          { key: 'open', label: T('recon.openCount'), type: 'int', render: (r) => fNum(r.summary?.open, 0), text: (r) => r.summary?.open ?? null },
          { key: 'over', label: T('recon.over48'), type: 'int', render: (r) => fNum(r.summary?.unexplained_over_48h, 0), text: (r) => r.summary?.unexplained_over_48h ?? null },
          { key: 'by_class', label: T('recon.byClass'), render: (r) => Object.entries((r.summary?.by_class ?? {}) as Row).map(([k, v]) => `${E(k)}: ${v}`).join(', ') || '—' },
          { key: 'signed_by', lookup: 'user' } as Column, { key: 'signed_at', type: 'datetime' },
        ], lk)}
        actions={(r) => (maySign && !r.signed_at ? <Button small variant="primary" disabled={act.busy} data-testid="sign-run" onClick={() => void act.run(async () => { await rpc('rpc_recon_signoff', { p_run: r.id }); runs.reload(); })}>{T('recon.sign')}</Button> : null)}
      />
    </>
  );
}

export function ReconciliationScreen() {
  return (
    <Tabs
      tabs={[
        { id: 'inbound', label: T('recon.tabs.inbound'), render: () => <Inbound /> },
        { id: 'outbound', label: T('recon.tabs.outbound'), render: () => <Outbound /> },
        { id: 'diffs', label: T('recon.tabs.diffs'), render: () => <Diffs /> },
        { id: 'signoff', label: T('recon.tabs.signoff'), render: () => <SignOff /> },
      ]}
    />
  );
}
