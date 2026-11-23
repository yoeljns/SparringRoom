import { NextResponse } from 'next/server';
import { isAuthorizedCron } from '@/lib/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Real-time alert sweep (spec 12.5), every 5 minutes.
 * WIRING: stub. The data RPCs and the email / Telegram senders are added
 * when the lead sends the RPC list.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  return NextResponse.json({ error: 'NOT_IMPLEMENTED', job: 'alerts' }, { status: 501 });
}
