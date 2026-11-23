/**
 * Back-office data access. Reads are plain selects on tables and views under
 * row-level security; every write is an rpc_* function or post_txn.
 * Only plain column selects and simple filters are used (no embedded
 * resources), so joins are done client-side on small lists.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getBrowserSupabase } from '@/lib/supabase/browser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

/** A refused call. `code` is the leading UPPER_SNAKE token of the server message. */
export class ApiError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

export function parseServerMessage(message: string | null | undefined, fallbackCode = 'UNKNOWN'): ApiError {
  const text = (message ?? '').trim();
  const m = /^([A-Z][A-Z0-9_]{2,})\s*:?\s*([\s\S]*)$/.exec(text);
  if (m) return new ApiError(m[1], m[2].trim());
  return new ApiError(fallbackCode, text);
}

function fromPostgrest(error: { message?: string; code?: string; details?: string | null }): ApiError {
  const parsed = parseServerMessage(error.message, error.code || 'UNKNOWN');
  // Constraint violations carry no business code; map the SQLSTATE class.
  if (parsed.code === (error.code || 'UNKNOWN')) {
    if (error.code === '23505') return new ApiError('DUPLICATE', error.message ?? '');
    if (error.code === '23503') return new ApiError('REFERENCED', error.message ?? '');
    if (error.code === '23514' || error.code === '23502') return new ApiError('CONSTRAINT', error.message ?? '');
    if (error.code === '42501') return new ApiError('NOT_PERMITTED', error.message ?? '');
    if (error.code?.startsWith('22')) return new ApiError('INVALID', error.message ?? '');
  }
  return parsed;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any;

/** select from a table or view. `build` adds filters / order / limit. */
export async function rows<T = Row>(
  table: string,
  build?: (q: Query) => Query,
  select = '*',
  client: SupabaseClient = getBrowserSupabase(),
): Promise<T[]> {
  let q: Query = client.from(table).select(select);
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw fromPostgrest(error);
  return (data ?? []) as T[];
}

/** Call an rpc_* function that RAISEs on refusal. */
export async function rpc<T = Row>(name: string, args: Record<string, unknown> = {}, client: SupabaseClient = getBrowserSupabase()): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw fromPostgrest(error);
  return data as T;
}

/** Call post_txn / rpc_floor, which RETURN {error, message} on refusal. */
export async function rpcReturning<T = Row>(name: string, args: Record<string, unknown>): Promise<T> {
  const data = await rpc<Row>(name, args);
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    const parsed = parseServerMessage(data.message, data.error);
    throw new ApiError(data.error, parsed.code === data.error ? parsed.detail : String(data.message ?? ''));
  }
  return data as T;
}

export function upsert(table: string, row: Row): Promise<Row> {
  return rpc('rpc_upsert', { p_table: table, p_row: row });
}

export function remove(table: string, id: string): Promise<void> {
  return rpc('rpc_delete', { p_table: table, p_id: id });
}

export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

export function byId<T extends Row>(list: readonly T[], key = 'id'): Map<string, T> {
  return new Map(list.map((r) => [String(r[key]), r]));
}

/** Storage upload of a text file; resolves to the object path. */
export async function uploadText(bucket: string, path: string, text: string): Promise<string> {
  const { error } = await getBrowserSupabase()
    .storage.from(bucket)
    .upload(path, new Blob([text], { type: 'text/csv;charset=utf-8' }), { upsert: true, contentType: 'text/csv' });
  if (error) throw new ApiError('STORAGE', error.message);
  return path;
}

export function downloadTextFile(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
