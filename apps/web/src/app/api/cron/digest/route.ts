import { NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { runDigest } from '@/lib/notify/cron';
import { notifyEnv } from '@/lib/notify/send';
import { getServiceSupabase } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily digest (spec 12.4), 04:00 UTC = 07:00 Istanbul: rpc_digest rendered in Turkish with a link per item.
 * Auth: "Authorization: Bearer <CRON_SECRET>". Channels without configuration are skipped and reported.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const db = getServiceSupabase();
  if (!db) return NextResponse.json({ error: 'NOT_CONFIGURED', detail: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 503 });
  const appUrl = process.env.APP_URL || new URL(request.url).origin;
  const result = await runDigest(db, notifyEnv(), appUrl, (url, init) => fetch(url, init));
  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
