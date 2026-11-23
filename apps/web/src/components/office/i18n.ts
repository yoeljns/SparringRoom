import { hasMessage, t, type MessageKey, type MessageVars } from '@/i18n';
import { ApiError } from '@/lib/data/office-db';

/** Missing keys are shown in brackets so the browser test can find them. */
export function T(key: string, vars?: MessageVars): string {
  const full = `office.${key}`;
  return hasMessage(full) ? t(full as MessageKey, vars) : `⟦${key}⟧`;
}

/** Column / field label: office.col.<name>, falling back to the name. */
export function L(name: string): string {
  const full = `office.col.${name}`;
  return hasMessage(full) ? t(full as MessageKey) : name;
}

/** Enumerated value (state, type, band ...): office.enum.<value>. */
export function E(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const full = `office.enum.${String(value)}`;
  return hasMessage(full) ? t(full as MessageKey) : String(value);
}

/** Turkish text for a refused call: translated code plus the server detail. */
export function errText(err: unknown): string {
  if (err instanceof ApiError) {
    const key = `office.err.${err.code}`;
    const base = hasMessage(key) ? t(key as MessageKey) : hasMessage(`errors.${err.code}`) ? t(`errors.${err.code}` as MessageKey) : T('err.UNKNOWN');
    return err.detail ? `${base} (${err.code}: ${err.detail})` : `${base} (${err.code})`;
  }
  if (err instanceof Error) return `${T('err.UNKNOWN')} (${err.message})`;
  return T('err.UNKNOWN');
}

const TZ = 'Europe/Istanbul';
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 });
const dateFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dtFmt = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fNum(v: unknown, digits: 0 | 2 | 3 = 3): string {
  const n = num(v);
  if (n === null) return '—';
  return (digits === 0 ? nf0 : digits === 2 ? nf2 : nf3).format(n);
}
export function fPct(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : `%${nf2.format(n)}`;
}
/** A 0..1 ratio shown as a percentage. */
export function fRatio(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : `%${nf2.format(n * 100)}`;
}
export function fEur(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : `${nf0.format(n)} €`;
}
/** DD.MM.YYYY; a plain ISO date is not shifted by the time zone. */
export function fDate(v: unknown): string {
  if (!v) return '—';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : dateFmt.format(d);
}
export function fDateTime(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : dtFmt.format(d).replace(',', '');
}
/** Today in Istanbul as YYYY-MM-DD. */
export function todayIso(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}
