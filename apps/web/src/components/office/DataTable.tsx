'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { Row } from '@/lib/data/office-db';
import { fDate, fDateTime, fEur, fNum, fPct, fRatio, L, T } from './i18n';
import { Empty, Loading, Notice, StatusBadge, inputCls } from './ui';

export type ColType = 'text' | 'num' | 'int' | 'date' | 'datetime' | 'badge' | 'bool' | 'pct' | 'ratio' | 'eur' | 'json' | 'mono';

export interface Column<R extends Row = Row> {
  key: string;
  label?: string;
  type?: ColType;
  render?: (row: R) => ReactNode;
  /** Text used for search and sorting when render is custom. */
  text?: (row: R) => string | number | null;
}

export function formatCell(type: ColType | undefined, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-muted">—</span>;
  switch (type) {
    case 'num': return fNum(v);
    case 'int': return fNum(v, 0);
    case 'date': return fDate(v);
    case 'datetime': return fDateTime(v);
    case 'badge': return <StatusBadge value={v} />;
    case 'bool': return v === true || v === 'true' ? T('c.yes') : T('c.no');
    case 'pct': return fPct(v);
    case 'ratio': return fRatio(v);
    case 'eur': return fEur(v);
    case 'json': return <code className="block max-w-xs truncate text-xs" title={JSON.stringify(v)}>{JSON.stringify(v)}</code>;
    case 'mono': return <code className="text-xs">{String(v)}</code>;
    default: return String(v);
  }
}

const RIGHT: ColType[] = ['num', 'int', 'pct', 'ratio', 'eur'];

function searchText(row: Row, columns: Column[]): string {
  return columns
    .map((c) => (c.text ? c.text(row) : row[c.key]))
    .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
    .join(' ')
    .toLocaleLowerCase('tr');
}

/** Shared list: search, sort, paging, loading / empty / error states. */
export function DataTable<R extends Row = Row>({
  rows, columns, loading, error, empty, search = true, toolbar, onRowClick, rowKey, pageSize = 25, actions, initialQuery = '', footer, testId,
}: {
  rows: readonly R[] | undefined;
  columns: Column<R>[];
  loading?: boolean;
  error?: string | null;
  empty?: string;
  search?: boolean;
  toolbar?: ReactNode;
  onRowClick?: (row: R) => void;
  rowKey?: (row: R, index: number) => string;
  pageSize?: number;
  actions?: (row: R) => ReactNode;
  initialQuery?: string;
  footer?: ReactNode;
  testId?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let list = [...(rows ?? [])];
    const q = query.trim().toLocaleLowerCase('tr');
    if (q) list = list.filter((r) => searchText(r, columns as Column[]).includes(q));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      const val = (r: R) => (col?.text ? col.text(r) : r[sort.key]);
      list.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const nx = Number(x);
        const ny = Number(y);
        if (Number.isFinite(nx) && Number.isFinite(ny) && typeof x !== 'boolean') return (nx - ny) * sort.dir;
        return String(x).localeCompare(String(y), 'tr') * sort.dir;
      });
    }
    return list;
  }, [rows, query, sort, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * pageSize, (current + 1) * pageSize);

  return (
    <div data-testid={testId}>
      {search || toolbar ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {search ? (
            <input
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              placeholder={T('c.search')}
              aria-label={T('c.search')}
              className={`${inputCls} max-w-xs`}
            />
          ) : null}
          {toolbar}
          <span className="ml-auto text-xs text-muted">{T('c.rows', { n: filtered.length })}</span>
        </div>
      ) : null}
      {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
      {rows === undefined && loading ? <Loading /> : shown.length === 0 ? (error ? null : <Empty>{empty}</Empty>) : (
        <div className={`overflow-x-auto rounded-md border border-line ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-ink text-left text-xs uppercase tracking-wide text-paper">
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={`whitespace-nowrap px-3 py-2 font-semibold ${RIGHT.includes(c.type ?? 'text') ? 'text-right' : ''}`}>
                    <button type="button" className="font-semibold uppercase" onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                      {c.label ?? L(c.key)}
                      {sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
                {actions ? <th scope="col" className="px-3 py-2 text-right font-semibold">{T('c.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr
                  key={rowKey ? rowKey(row, i) : String(row.id ?? i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-t border-line odd:bg-paper even:bg-surface/60 ${onRowClick ? 'cursor-pointer hover:bg-brand-soft/50' : ''}`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 align-top ${RIGHT.includes(c.type ?? 'text') ? 'text-right tabular-nums' : ''}`}>
                      {c.render ? c.render(row) : formatCell(c.type, row[c.key])}
                    </td>
                  ))}
                  {actions ? (
                    <td className="whitespace-nowrap px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <span className="inline-flex gap-1">{actions(row)}</span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            {footer ? <tfoot>{footer}</tfoot> : null}
          </table>
        </div>
      )}
      {pages > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted">
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">‹</button>
          <span>{current + 1} / {pages}</span>
          <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">›</button>
        </div>
      ) : null}
    </div>
  );
}
