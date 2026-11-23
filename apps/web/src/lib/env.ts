/**
 * Public runtime configuration. Only NEXT_PUBLIC_* values are read here, so
 * this module is safe in client code. There is no service key anywhere in
 * the web app (spec 13.1, "Security").
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** False during a build without env vars; the app then shows a config notice. */
export const isSupabaseConfigured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

/** Placeholders keep `next build` working without env vars; never used for real calls. */
export const SUPABASE_URL_OR_PLACEHOLDER = SUPABASE_URL || 'http://127.0.0.1:54321';
export const SUPABASE_ANON_KEY_OR_PLACEHOLDER = SUPABASE_ANON_KEY || 'missing-anon-key';

/**
 * Development only: skip sign-in and use a fake profile. The flag is ignored
 * in production builds whatever its value.
 */
export const DEV_NO_AUTH = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_NO_AUTH === '1';
export const DEV_ROLE = process.env.NEXT_PUBLIC_DEV_ROLE ?? 'owner';
