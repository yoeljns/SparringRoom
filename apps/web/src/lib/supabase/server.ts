import 'server-only';

import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { SUPABASE_ANON_KEY_OR_PLACEHOLDER, SUPABASE_URL_OR_PLACEHOLDER } from '@/lib/env';

/**
 * Server Supabase client for Server Components and Route Handlers. It uses
 * the anon key and the caller's session cookie, so row-level security applies.
 */
export async function getServerSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL_OR_PLACEHOLDER, SUPABASE_ANON_KEY_OR_PLACEHOLDER, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session.
        }
      },
    },
  });
}
