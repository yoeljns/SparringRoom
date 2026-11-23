'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { rows, type Row } from '@/lib/data/office-db';
import { DataTable, type Column } from './DataTable';
import { useLoad } from './hooks';
import { T } from './i18n';
import { useLookups, withLookups } from './lookups';
import { Drawer, Json, Notice } from './ui';

/** Requests in job_queue for the planning worker; polls while any is queued or running. */
export function JobList({ kinds, version = 0, renderResult, describe, limit = 20 }: {
  kinds: string[]; version?: number; renderResult?: (job: Row) => ReactNode; describe?: (job: Row) => ReactNode; limit?: number;
}) {
  const lk = useLookups(['user']);
  const jobs = useLoad(() => rows('job_queue', (q) => q.in('kind', kinds).order('created_at', { ascending: false }).limit(limit)), [kinds.join(','), version]);
  const [open, setOpen] = useState<Row | null>(null);
  const pending = (jobs.data ?? []).some((j) => j.state === 'queued' || j.state === 'running');
  const reload = jobs.reload;
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [pending, reload]);
  const current = open ? ((jobs.data ?? []).find((j) => j.id === open.id) ?? open) : null;
  return (
    <>
      {pending ? <div className="mb-2"><Notice tone="warn">{T('jobs.waiting')}</Notice></div> : null}
      <DataTable
        testId="job-list"
        search={false}
        rows={jobs.data}
        loading={jobs.loading && !jobs.data}
        error={jobs.error}
        empty={T('jobs.empty')}
        onRowClick={setOpen}
        columns={withLookups([
          { key: 'created_at', type: 'datetime' }, { key: 'kind', type: 'badge' },
          ...(describe ? [{ key: 'payload', label: T('jobs.subject'), render: describe } as Column] : [{ key: 'payload', type: 'json' } as Column]),
          { key: 'state', type: 'badge' }, { key: 'requested_by', lookup: 'user' } as Column, { key: 'started_at', type: 'datetime' }, { key: 'finished_at', type: 'datetime' },
          { key: 'error', render: (r) => (r.error ? <span className="text-brand">{String(r.error).slice(0, 80)}</span> : '—') },
        ], lk)}
      />
      {current ? (
        <Drawer title={`${T('jobs.job')} · ${current.kind}`} onClose={() => setOpen(null)} wide>
          {current.state === 'queued' || current.state === 'running' ? <Notice tone="warn">{T('jobs.waiting')}</Notice> : null}
          {current.error ? <Notice>{current.error}</Notice> : null}
          {current.result ? (renderResult ? renderResult(current) : <Json value={current.result} />) : current.state === 'done' ? <Notice tone="mute">{T('jobs.noResult')}</Notice> : null}
          <details>
            <summary className="cursor-pointer text-sm text-muted">{T('jobs.payload')}</summary>
            <Json value={current.payload} />
          </details>
        </Drawer>
      ) : null}
    </>
  );
}
