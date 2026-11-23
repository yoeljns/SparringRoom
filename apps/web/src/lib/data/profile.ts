import type { SupabaseClient } from '@supabase/supabase-js';
import { isRole, type Role } from '@dayson/domain';
import { DEV_ROLE } from '@/lib/env';

/** Row of table app_user (id = auth user id). */
export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  active: boolean;
}

export type ProfileResult =
  | { status: 'ready'; profile: Profile }
  | { status: 'signed_out' }
  | { status: 'missing' }
  | { status: 'inactive'; profile: Profile }
  | { status: 'error'; message: string };

export function toProfile(row: unknown): Profile | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || !isRole(r.role)) return null;
  return {
    id: r.id,
    full_name: typeof r.full_name === 'string' ? r.full_name : '',
    role: r.role,
    active: r.active !== false,
  };
}

function isNetworkAuthError(error: { name?: string; status?: number } | null): boolean {
  // AuthRetryableFetchError: the auth server could not be reached.
  return !!error && (error.name === 'AuthRetryableFetchError' || error.status === 0 || (error.status ?? 0) >= 500);
}

/**
 * Read the signed-in user's row from app_user.
 *
 * Server code leaves `localSession` off: getUser() verifies the token with
 * the auth server. The browser passes `localSession: true` so the floor app
 * can start without network; the row itself is still protected by RLS.
 * A network failure is reported as "error", never as "signed_out", so the
 * caller can fall back to its cached profile.
 */
export async function fetchProfile(supabase: SupabaseClient, opts: { localSession?: boolean } = {}): Promise<ProfileResult> {
  try {
    let userId: string | null = null;
    if (opts.localSession) {
      const { data, error } = await supabase.auth.getSession();
      if (error) return isNetworkAuthError(error) ? { status: 'error', message: error.message } : { status: 'signed_out' };
      userId = data.session?.user.id ?? null;
    } else {
      const { data, error } = await supabase.auth.getUser();
      if (error && isNetworkAuthError(error)) return { status: 'error', message: error.message };
      userId = error ? null : (data.user?.id ?? null);
    }
    if (!userId) return { status: 'signed_out' };

    const { data, error } = await supabase.from('app_user').select('id, full_name, role, active').eq('id', userId).maybeSingle();
    if (error) return { status: 'error', message: error.message };
    const profile = toProfile(data);
    if (!profile) return { status: 'missing' };
    return profile.active ? { status: 'ready', profile } : { status: 'inactive', profile };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Fake profile used only with NEXT_PUBLIC_DEV_NO_AUTH=1 outside production. */
export function devProfile(): Profile {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    full_name: 'Deneme Kullanıcı',
    role: isRole(DEV_ROLE) ? DEV_ROLE : 'owner',
    active: true,
  };
}
