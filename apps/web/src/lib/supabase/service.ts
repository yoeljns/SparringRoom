import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role client for the cron routes only. The key is read from
 * SUPABASE_SERVICE_ROLE_KEY (never NEXT_PUBLIC_*), so it cannot reach the
 * browser bundle; `server-only` fails the build if a client file imports this.
 */
export function getServiceSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
