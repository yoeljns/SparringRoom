'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY_OR_PLACEHOLDER, SUPABASE_URL_OR_PLACEHOLDER } from '@/lib/env';

let client: SupabaseClient | null = null;

/** Browser Supabase client (anon key + the user's session cookie). */
export function getBrowserSupabase(): SupabaseClient {
  if (!client) client = createBrowserClient(SUPABASE_URL_OR_PLACEHOLDER, SUPABASE_ANON_KEY_OR_PLACEHOLDER);
  return client;
}
