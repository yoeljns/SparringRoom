/**
 * Scan classification and GS1 parsing (spec section 6, "Scan parsing").
 *
 * The floor app accepts three inputs in any scan field:
 *   - a location code (TZ-B03-L12, TZ-DOCK-01, TZ-STG-01, TZ-PF-A01)
 *   - a GS1 string beginning with a function character (ASCII 29) or a
 *     symbology identifier such as ]d2
 *   - a bare 18-digit pallet serial
 * Anything else is `unknown`; the caller refuses it with a tone and logs it.
 */

/** ASCII 29, the group separator that scanners emit for FNC1. */
export const GS = '\x1d';

/**
 * AIM symbology identifiers accepted in front of GS1 data.
 * ]d2 GS1 DataMatrix, ]Q3 GS1 QR, ]C1 GS1-128, ]e0 GS1 DataBar.
 * ]d1 and ]Q1 are the plain (non-FNC1) variants: the carton QR printed by
 * labels/carton.zpl carries a leading GS instead of a true FNC1 mode
 * indicator, so a scanner reports it as ]Q1. They are accepted only when the
 * payload parses completely as GS1 element strings.
 */
export const GS1_SYMBOLOGY_IDS = [']d2', ']Q3', ']C1', ']e0', ']d1', ']Q1'] as const;

export const LOCATION_CODE_RE = /^[A-Z]{2}-[A-Z0-9]+-[A-Z0-9]+$/;
export const PALLET_SERIAL_RE = /^\d{18}$/;

/** GS1 AI encodable character set 82, used by lot (10). */
const CSET82_RE = /^[!"%-?A-Z_a-z]+$/;

// ---------------------------------------------------------------------------
// Check digits and serials
// ---------------------------------------------------------------------------

/**
 * GS1 mod-10 check digit for a numeric string WITHOUT its check digit.
 * Works for GTIN-8/12/13/14 and SSCC: weights 3,1,3,... from the right.
 */
export function gs1CheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error('gs1CheckDigit: digits only');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the last digit of `full` is the correct GS1 check digit. */
export function hasValidGs1CheckDigit(full: string): boolean {
  if (!/^\d{2,}$/.test(full)) return false;
  return gs1CheckDigit(full.slice(0, -1)) === full.charCodeAt(full.length - 1) - 48;
}

export interface SsccParts {
  /** 0-9, chosen freely by the company. */
  extensionDigit: number | string;
  /** GS1 company prefix, 7-10 digits. Until one is confirmed use an internal prefix. */
  companyPrefix: string;
  /** Serial reference; left-padded with zeros to fill 16 digits with the prefix. */
  serialReference: number | bigint | string;
}

/** Build an 18-digit SSCC: extension digit + company prefix + serial + check digit. */
export function buildSscc(parts: SsccParts): string {
  const ext = String(parts.extensionDigit);
  if (!/^\d$/.test(ext)) throw new Error('buildSscc: extension digit must be one digit');
  if (!/^\d{4,12}$/.test(parts.companyPrefix)) throw new Error('buildSscc: company prefix must be 4-12 digits');
  const serialLen = 16 - parts.companyPrefix.length;
  const serial = String(parts.serialReference);
  if (!/^\d+$/.test(serial)) throw new Error('buildSscc: serial reference must be digits');
  if (serial.length > serialLen) throw new Error(`buildSscc: serial reference longer than ${serialLen} digits`);
  const body = ext + parts.companyPrefix + serial.padStart(serialLen, '0');
  return body + gs1CheckDigit(body);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse a GS1 YYMMDD date to an ISO date (YYYY-MM-DD), or null when invalid.
 * Century rule (GS1 General Specifications 7.12): with d = YY - current YY,
 * d >= 51 is the previous century, d <= -50 the next, otherwise the current.
 * Day 00 means the last day of the month.
 */
export function parseGs1Date(yymmdd: string, now: Date = new Date()): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const currentYear = now.getUTCFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  const diff = yy - (currentYear % 100);
  let year = currentCentury + yy;
  if (diff >= 51) year -= 100;
  else if (diff <= -50) year += 100;
  const last = daysInMonth(year, mm);
  if (dd === 0) dd = last;
  if (dd > last) return null;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** ISO date (YYYY-MM-DD) to GS1 YYMMDD. */
export function formatGs1Date(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`formatGs1Date: not an ISO date: ${isoDate}`);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(Number(m[1]), month)) {
    throw new Error(`formatGs1Date: invalid date: ${isoDate}`);
  }
  return m[1].slice(2) + m[2] + m[3];
}

// ---------------------------------------------------------------------------
// GS1 element string parser
// ---------------------------------------------------------------------------

export interface Gs1Data {
  /** (00) SSCC or internal pallet serial, 18 digits. */
  sscc?: string;
  /** (01) GTIN, 14 digits. */
  gtin?: string;
  /** (17) expiry, ISO date. */
  expiry?: string;
  /** (11) production date, ISO date. */
  productionDate?: string;
  /** (10) lot. */
  lot?: string;
}

export interface Gs1ParseResult {
  ok: boolean;
  /** Symbology identifier found in front of the data, if any. */
  symbologyId?: string;
  data: Gs1Data;
  /** Fatal problems: the scan must be refused. */
  errors: string[];
  /** Non-fatal findings, e.g. a wrong check digit on an internal serial. */
  warnings: string[];
}

const FIXED_AI: Record<string, { length: number; field: keyof Gs1Data; date?: boolean }> = {
  '00': { length: 18, field: 'sscc' },
  '01': { length: 14, field: 'gtin' },
  '17': { length: 6, field: 'expiry', date: true },
  '11': { length: 6, field: 'productionDate', date: true },
};

/** Remove a leading symbology identifier and FNC1/GS characters. */
export function stripGs1Prefix(input: string): { symbologyId?: string; body: string } {
  let body = input;
  let symbologyId: string | undefined;
  for (const id of GS1_SYMBOLOGY_IDS) {
    if (body.startsWith(id)) {
      symbologyId = id;
      body = body.slice(id.length);
      break;
    }
  }
  while (body.startsWith(GS)) body = body.slice(1);
  return { symbologyId, body };
}

/**
 * Parse GS1 element strings with AIs (00) (01) (17) (11) (10).
 * Fixed-length AIs may follow each other directly; (10) runs to the next GS
 * or to the end of the data.
 */
export function parseGs1(input: string, opts: { now?: Date } = {}): Gs1ParseResult {
  const { symbologyId, body } = stripGs1Prefix(input);
  const data: Gs1Data = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let i = 0;

  if (body.length === 0) errors.push('EMPTY');

  while (i < body.length && errors.length === 0) {
    if (body[i] === GS) {
      i++;
      continue;
    }
    const ai = body.slice(i, i + 2);
    if (seen.has(ai)) {
      errors.push(`DUPLICATE_AI_${ai}`);
      break;
    }
    const fixed = FIXED_AI[ai];
    if (fixed) {
      const value = body.slice(i + 2, i + 2 + fixed.length);
      if (value.length !== fixed.length || !/^\d+$/.test(value)) {
        errors.push(`BAD_VALUE_${ai}`);
        break;
      }
      if (fixed.date) {
        const iso = parseGs1Date(value, opts.now);
        if (!iso) {
          errors.push(`BAD_DATE_${ai}`);
          break;
        }
        data[fixed.field] = iso;
      } else {
        data[fixed.field] = value;
        if (!hasValidGs1CheckDigit(value)) warnings.push(`CHECK_DIGIT_${ai}`);
      }
      seen.add(ai);
      i += 2 + fixed.length;
    } else if (ai === '10') {
      const end = body.indexOf(GS, i + 2);
      const value = body.slice(i + 2, end === -1 ? body.length : end);
      if (value.length < 1 || value.length > 20 || !CSET82_RE.test(value)) {
        errors.push('BAD_VALUE_10');
        break;
      }
      data.lot = value;
      seen.add(ai);
      i = end === -1 ? body.length : end + 1;
    } else {
      errors.push(`UNKNOWN_AI_${ai}`);
      break;
    }
  }

  return { ok: errors.length === 0, symbologyId, data: errors.length === 0 ? data : {}, errors, warnings };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export type ScanKind = 'location' | 'gs1' | 'pallet_serial' | 'unknown';

export type ClassifiedScan =
  | { kind: 'location'; raw: string; code: string }
  | { kind: 'gs1'; raw: string; symbologyId?: string; data: Gs1Data; warnings: string[] }
  | { kind: 'pallet_serial'; raw: string; serial: string; checkDigitValid: boolean }
  | { kind: 'unknown'; raw: string; reason: 'empty' | 'gs1_invalid' | 'unrecognised'; errors: string[] };

/** True when the string starts with a function character or a symbology identifier. */
export function looksLikeGs1(value: string): boolean {
  return value.startsWith(GS) || GS1_SYMBOLOGY_IDS.some((id) => value.startsWith(id));
}

/** Classify any scanned (or manually typed) string. Never throws. */
export function classifyScan(raw: string, opts: { now?: Date } = {}): ClassifiedScan {
  // DataWedge appends Enter; trim() keeps ASCII 29 because it is not whitespace.
  const value = (raw ?? '').replace(/[\r\n]+/g, '').trim();
  if (value.length === 0) return { kind: 'unknown', raw, reason: 'empty', errors: [] };

  if (looksLikeGs1(value)) {
    const parsed = parseGs1(value, opts);
    if (!parsed.ok) return { kind: 'unknown', raw, reason: 'gs1_invalid', errors: parsed.errors };
    return { kind: 'gs1', raw, symbologyId: parsed.symbologyId, data: parsed.data, warnings: parsed.warnings };
  }

  if (PALLET_SERIAL_RE.test(value)) {
    return { kind: 'pallet_serial', raw, serial: value, checkDigitValid: hasValidGs1CheckDigit(value) };
  }

  const upper = value.toUpperCase();
  if (LOCATION_CODE_RE.test(upper)) return { kind: 'location', raw, code: upper };

  return { kind: 'unknown', raw, reason: 'unrecognised', errors: [] };
}

/** Pallet serial carried by a scan: a bare serial or the (00) of a GS1 label. */
export function palletSerialOf(scan: ClassifiedScan): string | null {
  if (scan.kind === 'pallet_serial') return scan.serial;
  if (scan.kind === 'gs1') return scan.data.sscc ?? null;
  return null;
}
