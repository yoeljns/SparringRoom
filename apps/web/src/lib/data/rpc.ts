/**
 * The single place where the web app calls database functions.
 * Clients never write tables directly: every business write is post_txn or
 * an rpc_* function (spec section 2, "Write path").
 *
 * Results are classified so the offline outbox knows what to do:
 *   ok         done (a repeated client_uuid also returns ok)
 *   business   the server refused the command; never retried
 *   transient  network, timeout, 5xx, rate limit or expired session; retried
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Error codes of the post_txn contract (spec 4.5). */
export const POST_TXN_ERROR_CODES = [
  'UNBALANCED',
  'NEGATIVE_BALANCE',
  'LANE_MIXED',
  'LOT_REQUIRED',
  'MRSL_BLOCKED',
  'NOT_PERMITTED',
  'APPROVAL_REQUIRED',
] as const;

export type RpcOutcome<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; kind: 'business'; code: string; message: string }
  | { ok: false; kind: 'transient'; message: string; auth?: boolean };

export interface RawRpcError {
  /** HTTP status; 0 or undefined when the request never reached the server. */
  status?: number;
  /** Postgres SQLSTATE or PostgREST code (PGRSTxxx). */
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/** Leading UPPER_SNAKE token of a RAISE EXCEPTION message, e.g. "NEGATIVE_BALANCE: ...". */
export function businessCodeOf(error: RawRpcError): string {
  const m = /^\s*([A-Z][A-Z0-9_]{2,})\b/.exec(error.message ?? '');
  if (m) return m[1];
  return error.code || 'UNKNOWN';
}

export function classifyRpcError(error: RawRpcError): Exclude<RpcOutcome, { ok: true }> {
  const status = error.status ?? 0;
  const message = error.message || 'Unknown error';
  const code = error.code ?? '';

  // Expired or missing session: retry after the token refresh, never drop the command.
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302' || /jwt expired/i.test(message)) {
    return { ok: false, kind: 'transient', message, auth: true };
  }
  // Never reached the server, or the server/proxy failed.
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) {
    // A raised business exception can surface as 500 only with SQLSTATE class P0/23; keep those as business.
    if (status >= 500 && /^(P0|23|22)/.test(code)) {
      return { ok: false, kind: 'business', code: businessCodeOf(error), message };
    }
    return { ok: false, kind: 'transient', message };
  }
  // Serialization failure, deadlock, lock timeout: safe to retry.
  if (code === '40001' || code === '40P01' || code === '55P03' || code === '57014') {
    return { ok: false, kind: 'transient', message };
  }
  return { ok: false, kind: 'business', code: businessCodeOf(error), message };
}

/**
 * post_txn and rpc_floor do not raise: they RETURN a refusal as
 * {"error": "CODE", "message": "CODE: detail"} with HTTP 200 (docs/api.md,
 * "Error conventions"), so the refusal can be logged server-side.
 */
export const RETURNS_REFUSAL = ['rpc_floor', 'post_txn'] as const;

export function returnedRefusal(name: string, data: unknown): Extract<RpcOutcome, { kind: 'business' }> | null {
  if (!(RETURNS_REFUSAL as readonly string[]).includes(name)) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.error !== 'string' || row.error.length === 0) return null;
  return { ok: false, kind: 'business', code: row.error, message: typeof row.message === 'string' ? row.message : row.error };
}

/** Call a database function and classify the result. Never throws. */
export async function callRpc<T = unknown>(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<RpcOutcome<T>> {
  try {
    const { data, error, status } = await supabase.rpc(name, args);
    if (!error) {
      const refusal = returnedRefusal(name, data);
      return refusal ?? { ok: true, data: data as T };
    }
    return classifyRpcError({ status, code: error.code, message: error.message, details: error.details, hint: error.hint });
  } catch (err) {
    return { ok: false, kind: 'transient', message: err instanceof Error ? err.message : String(err) };
  }
}
