/**
 * Daily digest (spec 12.4) and real-time alerts (12.5) as text and HTML.
 * Pure functions: the cron routes and the digest preview screen both use them.
 */
import { hasMessage, t, type MessageKey, type MessageVars } from '@/i18n';

type Obj = Record<string, unknown>;

function T(key: string, vars?: MessageVars): string {
  const full = `office.digest.${key}`;
  return hasMessage(full) ? t(full as MessageKey, vars) : key;
}

export interface DigestSection {
  key: string;
  title: string;
  /** Path inside the app; the sender prefixes APP_URL. */
  path: string;
  lines: string[];
  /** True when the section needs attention. */
  flagged: boolean;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });

function pct(v: unknown): string {
  return v === null || v === undefined ? '—' : `%${nf.format(Number(v))}`;
}
function n(v: unknown): string {
  return v === null || v === undefined || v === '' ? '—' : typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? nf.format(Number(v)) : String(v);
}
export function trDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(v ?? '—');
}
function list(v: unknown): Obj[] {
  return Array.isArray(v) ? (v as Obj[]) : [];
}
/** "sku: X, lot_no: Y" for payloads without a dedicated sentence. */
export function payloadLine(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');
  return Object.entries(payload as Obj)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${labelOf(k)}: ${/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? trDate(v) : n(v)}`)
    .join(', ');
}
function labelOf(key: string): string {
  const full = `office.col.${key}`;
  return hasMessage(full) ? t(full as MessageKey) : key;
}
function enumOf(value: unknown): string {
  const full = `office.enum.${String(value)}`;
  return hasMessage(full) ? t(full as MessageKey) : String(value);
}

/** The eight digest sections of spec 12.4, in order, each with a link target. */
export function digestSections(d: Obj): DigestSection[] {
  const acc = (d.accuracy ?? {}) as Obj;
  const rec = (d.reconciliation ?? {}) as Obj;
  const byClass = Object.entries((rec.by_class ?? {}) as Obj);
  const older = Number(rec.older_than_48h ?? 0);
  const below = list(d.below_safety_4w);
  const lots = list(d.lots_amber_red);
  const blocked = list(d.expiry_blocked_waiting);
  const late = list(d.inbound_late);
  const camps = list(d.campaigns_off_forecast);
  const weights = list(d.weight_overrides);
  const noInvoice = list(d.shipments_no_invoice);
  const approvals = list(d.approvals_waiting);
  const owner = approvals.filter((a) => a.for_owner === true);
  const fva = list(d.negative_fva_sources);
  const none = T('none');
  return [
    {
      key: 'accuracy', title: T('accuracy'), path: '/stock?tab=ira', flagged: false,
      lines: [
        T('ira', { y: pct(acc.ira_yesterday), w: pct(acc.ira_7d) }),
        T('scan', { y: pct(acc.scan_yesterday), w: pct(acc.scan_7d) }),
      ],
    },
    {
      key: 'reconciliation', title: T('recon'), path: '/reconciliation?tab=diffs', flagged: older > 0,
      lines: [
        byClass.length ? byClass.map(([k, v]) => `${enumOf(k)}: ${n(v)}`).join(', ') : T('reconNone'),
        T('reconOld', { n: older }),
      ],
    },
    {
      key: 'below_safety', title: T('belowSafety'), path: '/planning?tab=projection', flagged: below.length > 0,
      lines: below.length ? below.map((b) => T('belowSafetyLine', { sku: String(b.sku), week: trDate(b.week), projected: n(b.projected), ss: n(b.safety_stock) })) : [none],
    },
    {
      key: 'lots', title: T('lots'), path: '/stock?tab=lots', flagged: lots.length > 0 || blocked.length > 0,
      lines: [
        ...lots.map((l) => T('lotLine', { sku: String(l.sku), lot: String(l.lot_no), band: enumOf(l.band), days: n(l.days_left) })),
        ...blocked.map((l) => T('blockedLine', { sku: String(l.sku), lot: String(l.lot_no), qty: n(l.qty) })),
        ...(lots.length + blocked.length === 0 ? [none] : []),
      ],
    },
    { key: 'inbound_late', title: T('inboundLate'), path: '/supply?tab=po', flagged: late.length > 0, lines: late.length ? late.map(payloadLine) : [none] },
    { key: 'campaigns', title: T('campaigns'), path: '/campaigns?tab=list&state=live', flagged: camps.length > 0, lines: camps.length ? camps.map(payloadLine) : [none] },
    {
      key: 'trucks', title: T('trucks'), path: '/shipping?tab=shipments', flagged: weights.length + noInvoice.length > 0,
      lines: [
        ...weights.map((w) => `${T('weightOverride')}: ${payloadLine(w)}`),
        ...noInvoice.map((s) => `${T('noInvoice')}: ${payloadLine(s)}`),
        ...(weights.length + noInvoice.length === 0 ? [none] : []),
      ],
    },
    {
      key: 'approvals', title: T('approvals'), path: '/approvals', flagged: owner.length > 0,
      lines: [
        T('approvalsCount', { owner: owner.length, all: approvals.length }),
        ...approvals.map((a) => `${enumOf(a.type)}${a.reason ? `: ${String(a.reason)}` : ''}`),
        ...fva.map((f) => T('negativeFva', { source: enumOf(f.source), fva: n(f.fva) })),
      ],
    },
  ];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function link(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, '')}${path}`;
}

/** Digest as it is sent: plain text for Telegram (HTML parse mode safe), HTML for email. */
export function renderDigest(digest: unknown, appUrl: string): RenderedMessage & { sections: DigestSection[] } {
  const d = (digest ?? {}) as Obj;
  const sections = digestSections(d);
  const date = trDate(d.date);
  const subject = T('subject', { date });
  const text = [
    `<b>${escapeHtml(subject)}</b>`,
    ...sections.map((s) => [`${s.flagged ? '🔴' : '⚪'} <a href="${escapeHtml(link(appUrl, s.path))}">${escapeHtml(s.title)}</a>`, ...s.lines.map((l) => `• ${escapeHtml(l)}`)].join('\n')),
  ].join('\n\n');
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0b0b0c;max-width:640px">',
    `<h1 style="font-size:20px;border-bottom:3px solid #d6001c;padding-bottom:8px">${escapeHtml(subject)}</h1>`,
    ...sections.map((s) => [
      `<h2 style="font-size:15px;margin:18px 0 6px"><a href="${escapeHtml(link(appUrl, s.path))}" style="color:${s.flagged ? '#d6001c' : '#0b0b0c'}">${escapeHtml(s.title)}</a></h2>`,
      `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5">${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    ].join('')),
    '</div>',
  ].join('');
  return { subject, text, html, sections };
}

export interface AlertRow {
  id: string;
  rule: string;
  severity: string;
  payload: unknown;
  created_at?: string;
  entity_type?: string | null;
}

export function alertTitle(rule: string): string {
  const full = `office.alertRule.${rule}`;
  return hasMessage(full) ? t(full as MessageKey) : rule;
}

/** Real-time alerts pushed to owner and ops_manager, one message for the batch. */
export function renderAlerts(alerts: readonly AlertRow[], appUrl: string): RenderedMessage {
  const subject = T('alertSubject', { n: alerts.length });
  const line = (a: AlertRow) => `${alertTitle(a.rule)} — ${payloadLine(a.payload)}`;
  const text = [`<b>${escapeHtml(subject)}</b>`, ...alerts.map((a) => `${a.severity === 'critical' ? '🔴' : '🟠'} <a href="${escapeHtml(link(appUrl, `/alerts?id=${a.id}`))}">${escapeHtml(alertTitle(a.rule))}</a>\n${escapeHtml(payloadLine(a.payload))}`)].join('\n\n');
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0b0b0c;max-width:640px">',
    `<h1 style="font-size:20px;border-bottom:3px solid #d6001c;padding-bottom:8px">${escapeHtml(subject)}</h1>`,
    '<ul style="padding-left:18px;font-size:14px;line-height:1.5">',
    ...alerts.map((a) => `<li><a href="${escapeHtml(link(appUrl, `/alerts?id=${a.id}`))}" style="color:#d6001c">${escapeHtml(line(a))}</a></li>`),
    '</ul></div>',
  ].join('');
  return { subject, text, html };
}
