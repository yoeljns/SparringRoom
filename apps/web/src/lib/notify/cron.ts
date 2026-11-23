/**
 * The two cron jobs as functions of a database client and a fetch
 * implementation, so they can be tested without a network.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderAlerts, renderDigest, type AlertRow } from './render';
import { deliver, type DeliveryReport, type NotifyEnv, type Recipient } from './send';

type Fetch = Parameters<typeof deliver>[3];

async function recipients(db: SupabaseClient): Promise<{ list: Recipient[]; error?: string }> {
  const { data, error } = await db.rpc('rpc_alert_recipients');
  if (error) return { list: [], error: error.message };
  return { list: Array.isArray(data) ? (data as Recipient[]) : [] };
}

export interface DigestRun {
  ok: boolean;
  job: 'digest';
  error?: string;
  date?: unknown;
  flagged?: string[];
  recipients_error?: string;
  delivery?: DeliveryReport;
}

/** rpc_digest -> Turkish digest with a link per item -> email and Telegram. */
export async function runDigest(db: SupabaseClient, env: NotifyEnv, appUrl: string, fetchImpl: Fetch): Promise<DigestRun> {
  const { data, error } = await db.rpc('rpc_digest');
  if (error) return { ok: false, job: 'digest', error: error.message };
  const message = renderDigest(data, appUrl);
  const rec = await recipients(db);
  const delivery = await deliver(message, rec.list, env, fetchImpl);
  return {
    ok: delivery.email.errors.length + delivery.telegram.errors.length === 0, job: 'digest', date: (data as { date?: unknown } | null)?.date,
    flagged: message.sections.filter((s) => s.flagged).map((s) => s.key), recipients_error: rec.error, delivery,
  };
}

export interface AlertsRun {
  ok: boolean;
  job: 'alerts';
  error?: string;
  pending: number;
  marked_sent: number;
  recipients_error?: string;
  delivery?: DeliveryReport;
}

/**
 * Unsent real-time alerts -> owner and ops_manager -> rpc_alerts_mark_sent.
 * Alerts are marked only after at least one channel accepted the message, so
 * a missing configuration or an outage never loses an alert.
 */
export async function runAlerts(db: SupabaseClient, env: NotifyEnv, appUrl: string, fetchImpl: Fetch): Promise<AlertsRun> {
  const { data, error } = await db.from('alert').select('id,rule,severity,payload,created_at,entity_type').eq('realtime', true).is('sent_at', null).order('created_at').limit(50);
  if (error) return { ok: false, job: 'alerts', error: error.message, pending: 0, marked_sent: 0 };
  const alerts = (data ?? []) as AlertRow[];
  if (alerts.length === 0) return { ok: true, job: 'alerts', pending: 0, marked_sent: 0 };
  const rec = await recipients(db);
  const delivery = await deliver(renderAlerts(alerts, appUrl), rec.list, env, fetchImpl);
  if (!delivery.delivered) {
    return { ok: delivery.email.errors.length + delivery.telegram.errors.length === 0, job: 'alerts', pending: alerts.length, marked_sent: 0, recipients_error: rec.error, delivery };
  }
  const marked = await db.rpc('rpc_alerts_mark_sent', { p_ids: alerts.map((a) => a.id) });
  if (marked.error) return { ok: false, job: 'alerts', error: marked.error.message, pending: alerts.length, marked_sent: 0, delivery };
  return { ok: true, job: 'alerts', pending: alerts.length, marked_sent: Number(marked.data ?? 0), recipients_error: rec.error, delivery };
}
