/**
 * All staff-facing strings live in tr.json (spec 13.1, "Language").
 * t('floor.screens.tasks') returns the string; {name} placeholders are
 * filled from vars. Keys are type-checked against the JSON file.
 */
import tr from './tr.json';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof tr>;
export type MessageVars = Record<string, string | number>;

function lookup(key: string): string | undefined {
  let node: unknown = tr;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function hasMessage(key: string): key is MessageKey {
  return lookup(key) !== undefined;
}

export function t(key: MessageKey, vars?: MessageVars): string {
  const template = lookup(key);
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** For keys built at run time (e.g. an error code); falls back when missing. */
export function tDynamic(key: string, fallback: MessageKey, vars?: MessageVars): string {
  return hasMessage(key) ? t(key, vars) : t(fallback, vars);
}

const TIME_ZONE = 'Europe/Istanbul';

/** Timestamps are stored in UTC and shown in Europe/Istanbul. */
export function formatDateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function formatTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(
    new Date(value),
  );
}

/** ISO date (YYYY-MM-DD) to DD.MM.YYYY. */
export function formatIsoDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}
