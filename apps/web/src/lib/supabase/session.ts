import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { DEV_NO_AUTH, SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from '@/lib/env';

/** Only same-site relative paths are allowed as a post-login target. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (value.startsWith('/login')) return '/';
  return value;
}

export function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/login/');
}

/**
 * Refresh the Supabase session cookie and protect routes:
 *   - pages without a user go to /login?next=...
 *   - /login with a user goes to /
 *   - /api/* is passed through; each route handler checks its own caller
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  if (DEV_NO_AUTH) return NextResponse.next({ request });

  if (!isSupabaseConfigured) {
    if (isApi || isPublicPath(pathname)) return NextResponse.next({ request });
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '?error=config';
    return NextResponse.redirect(url);
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() validates the token with the auth server and refreshes it.
  const { data } = await supabase.auth.getUser();
  const user = data.user;

  if (isApi) return response;

  const redirectTo = (path: string, query = '') => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = query;
    const redirect = NextResponse.redirect(url);
    // Keep refreshed session cookies on the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!user && !isPublicPath(pathname)) {
    const next = safeNextPath(pathname + search);
    return redirectTo('/login', next === '/' ? '' : `?next=${encodeURIComponent(next)}`);
  }
  if (user && isPublicPath(pathname)) {
    return redirectTo(safeNextPath(request.nextUrl.searchParams.get('next')));
  }
  return response;
}
