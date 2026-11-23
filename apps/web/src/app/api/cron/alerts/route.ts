import { NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';
import { runAlerts } from '@/lib/notify/cron';
import { notifyEnv } from '@/lib/notify/send';
import { getServiceSupabase } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Real-time alerts (spec 12.5), every 5 minutes: unsent alert rows pushed to owner and ops_manager, then marked sent.
 * Auth: "Authorization: Bearer <CRON_SECRET>". Channels without configuration are skipped and reported.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const db = getServiceSupabase();
  if (!db) return NextResponse.json({ error: 'NOT_CONFIGURED', detail: 'SUPABASE_SERVICE_ROLE_KEY missing' }, { status: 503 });
  const appUrl = process.env.APP_URL || new URL(request.url).origin;
  const result = await runAlerts(db, notifyEnv(), appUrl, (url, init) => fetch(url, init));
  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
