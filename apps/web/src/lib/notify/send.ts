/**
 * Delivery by email (Resend HTTP API) and Telegram (Bot API). A channel whose
 * environment variables are missing is skipped and reported, never an error.
 */
import type { RenderedMessage } from './render';

export interface NotifyEnv {
  RESEND_API_KEY?: string;
  DIGEST_EMAIL_FROM?: string;
  DIGEST_EMAIL_TO?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface Recipient {
  email?: string | null;
  telegram_chat_id?: string | null;
}

export interface ChannelReport {
  sent: number;
  skipped?: string;
  errors: string[];
}

export interface DeliveryReport {
  email: ChannelReport;
  telegram: ChannelReport;
  /** True when at least one message left on any channel. */
  delivered: boolean;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map((v) => (v ?? '').trim()).filter(Boolean))];
}

/** Recipients' own addresses first; the env list is the fallback when none is set. */
export function resolveTargets(recipients: readonly Recipient[], env: NotifyEnv): { emails: string[]; chats: string[] } {
  const emails = unique(recipients.map((r) => r.email));
  const chats = unique(recipients.map((r) => r.telegram_chat_id));
  return {
    emails: emails.length ? emails : unique((env.DIGEST_EMAIL_TO ?? '').split(',')),
    chats: chats.length ? chats : unique((env.TELEGRAM_CHAT_ID ?? '').split(',')),
  };
}

export async function sendEmail(env: NotifyEnv, to: string[], message: RenderedMessage, fetchImpl: FetchLike): Promise<ChannelReport> {
  if (!env.RESEND_API_KEY) return { sent: 0, skipped: 'RESEND_API_KEY missing', errors: [] };
  if (!env.DIGEST_EMAIL_FROM) return { sent: 0, skipped: 'DIGEST_EMAIL_FROM missing', errors: [] };
  if (to.length === 0) return { sent: 0, skipped: 'no email recipient', errors: [] };
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.DIGEST_EMAIL_FROM, to, subject: message.subject, html: message.html }),
    });
    if (!res.ok) return { sent: 0, errors: [`resend ${res.status}: ${(await res.text()).slice(0, 200)}`] };
    return { sent: to.length, errors: [] };
  } catch (err) {
    return { sent: 0, errors: [`resend: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Telegram messages are limited to 4096 characters; split on blank lines. */
export function splitTelegram(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    const piece = block.length > limit ? `${block.slice(0, limit - 1)}…` : block;
    if (current && current.length + piece.length + 2 > limit) {
      parts.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export async function sendTelegram(env: NotifyEnv, chats: string[], message: RenderedMessage, fetchImpl: FetchLike): Promise<ChannelReport> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0, skipped: 'TELEGRAM_BOT_TOKEN missing', errors: [] };
  if (chats.length === 0) return { sent: 0, skipped: 'no telegram chat', errors: [] };
  const report: ChannelReport = { sent: 0, errors: [] };
  for (const chat of chats) {
    let ok = true;
    for (const part of splitTelegram(message.text)) {
      try {
        const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        if (!res.ok) {
          ok = false;
          report.errors.push(`telegram ${res.status} (${chat}): ${(await res.text()).slice(0, 200)}`);
          break;
        }
      } catch (err) {
        ok = false;
        report.errors.push(`telegram (${chat}): ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    if (ok) report.sent += 1;
  }
  return report;
}

export async function deliver(message: RenderedMessage, recipients: readonly Recipient[], env: NotifyEnv, fetchImpl: FetchLike): Promise<DeliveryReport> {
  const targets = resolveTargets(recipients, env);
  const [email, telegram] = await Promise.all([sendEmail(env, targets.emails, message, fetchImpl), sendTelegram(env, targets.chats, message, fetchImpl)]);
  return { email, telegram, delivered: email.sent + telegram.sent > 0 };
}

export function notifyEnv(source: Record<string, string | undefined> = process.env): NotifyEnv {
  return {
    RESEND_API_KEY: source.RESEND_API_KEY || undefined,
    DIGEST_EMAIL_FROM: source.DIGEST_EMAIL_FROM || undefined,
    DIGEST_EMAIL_TO: source.DIGEST_EMAIL_TO || undefined,
    TELEGRAM_BOT_TOKEN: source.TELEGRAM_BOT_TOKEN || undefined,
    TELEGRAM_CHAT_ID: source.TELEGRAM_CHAT_ID || undefined,
  };
}
