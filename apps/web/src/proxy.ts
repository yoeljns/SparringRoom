import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/session';

/** Next.js 16 proxy (formerly middleware): session refresh and route protection. */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals, the service worker, the manifest and static assets.
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|api/cron/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)',
  ],
};
