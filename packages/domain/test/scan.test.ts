import { describe, expect, it } from 'vitest';
import {
  GS,
  buildSscc,
  classifyScan,
  encodeCartonGs1,
  encodePalletGs1,
  gs1CheckDigit,
  gs1HumanReadable,
  hasValidGs1CheckDigit,
  normalizeGtin14,
  palletSerialOf,
  parseGs1,
  parseGs1Date,
  formatGs1Date,
} from '../src';

const NOW = new Date('2026-11-23T10:00:00Z');

describe('gs1CheckDigit', () => {
  it('matches published examples', () => {
    expect(gs1CheckDigit('629104150021')).toBe(3); // GTIN-13 6291041500213
    expect(gs1CheckDigit('0629104150021')).toBe(3); // same as GTIN-14
    expect(gs1CheckDigit('400638133393')).toBe(1); // EAN-13 4006381333931
    expect(gs1CheckDigit('10614141234567890')).toBe(8); // SSCC 106141412345678908
  });

  it('validates a full number', () => {
    expect(hasValidGs1CheckDigit('6291041500213')).toBe(true);
    expect(hasValidGs1CheckDigit('6291041500214')).toBe(false);
    expect(hasValidGs1CheckDigit('4006381333931')).toBe(true); // well-known EAN-13
    expect(hasValidGs1CheckDigit('abc')).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(() => gs1CheckDigit('12a')).toThrow();
  });
});

describe('buildSscc', () => {
  it('builds extension + prefix + padded serial + check digit', () => {
    const sscc = buildSscc({ extensionDigit: 0, companyPrefix: '8691234', serialReference: 42 });
    expect(sscc).toHaveLength(18);
    expect(sscc.slice(0, 17)).toBe('0' + '8691234' + '000000042');
    expect(hasValidGs1CheckDigit(sscc)).toBe(true);
  });

  it('refuses a serial that does not fit', () => {
    expect(() => buildSscc({ extensionDigit: 1, companyPrefix: '8691234567', serialReference: '1234567' })).toThrow();
    expect(() => buildSscc({ extensionDigit: 12, companyPrefix: '8691234', serialReference: 1 })).toThrow();
  });
});

describe('parseGs1Date', () => {
  it('applies the century rule', () => {
    expect(parseGs1Date('271231', NOW)).toBe('2027-12-31');
    expect(parseGs1Date('760101', NOW)).toBe('2076-01-01'); // diff 50 -> current century
    expect(parseGs1Date('770101', NOW)).toBe('1977-01-01'); // diff 51 -> previous century
    expect(parseGs1Date('010101', new Date('2051-06-01T00:00:00Z'))).toBe('2101-01-01'); // diff -50 -> next
    expect(parseGs1Date('020101', new Date('2051-06-01T00:00:00Z'))).toBe('2002-01-01'); // diff -49
  });

  it('treats day 00 as the last day of the month', () => {
    expect(parseGs1Date('270200', NOW)).toBe('2027-02-28');
    expect(parseGs1Date('280200', NOW)).toBe('2028-02-29');
    expect(parseGs1Date('271100', NOW)).toBe('2027-11-30');
  });

  it('rejects impossible dates', () => {
    expect(parseGs1Date('271301', NOW)).toBeNull();
    expect(parseGs1Date('270230', NOW)).toBeNull();
    expect(parseGs1Date('27013', NOW)).toBeNull();
  });

  it('formats ISO dates', () => {
    expect(formatGs1Date('2027-05-31')).toBe('270531');
    expect(() => formatGs1Date('2027-02-30')).toThrow();
    expect(() => formatGs1Date('31.05.2027')).toThrow();
  });
});

const SSCC = buildSscc({ extensionDigit: 0, companyPrefix: '8691234', serialReference: 1001 });
const GTIN13 = '869123450001' + gs1CheckDigit('869123450001');

describe('GS1 encode / parse round trip', () => {
  const pallet = { sscc: SSCC, gtin: GTIN13, expiry: '2027-11-30', productionDate: '2026-11-19', lot: 'L26K1901' };

  it('encodes the pallet label with fixed-length AIs first and lot last', () => {
    const s = encodePalletGs1(pallet);
    expect(s).toBe(`00${SSCC}010${GTIN13}17271130112611191 0L26K1901`.replace('1 0', '10'));
    expect(s).not.toContain(GS);
    expect(gs1HumanReadable(s)).toBe(`(00)${SSCC}(01)0${GTIN13}(17)271130(11)261119(10)L26K1901`);
  });

  it.each([']d2', GS, ']Q3', ']C1', `]d2${GS}`])('round-trips the pallet label with prefix %j', (prefix) => {
    const parsed = parseGs1(prefix + encodePalletGs1(pallet), { now: NOW });
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.data).toEqual({
      sscc: SSCC,
      gtin: '0' + GTIN13,
      expiry: '2027-11-30',
      productionDate: '2026-11-19',
      lot: 'L26K1901',
    });
  });

  it('round-trips the carton label', () => {
    const s = encodeCartonGs1({ gtin: GTIN13, expiry: '2027-11-30', lot: 'AB-12/3_x' });
    const parsed = parseGs1(GS + s, { now: NOW });
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ gtin: '0' + GTIN13, expiry: '2027-11-30', lot: 'AB-12/3_x' });
  });

  it('reads a lot terminated by GS before another AI', () => {
    const parsed = parseGs1(`]d2010${GTIN13}10LOT7${GS}17270600`, { now: NOW });
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ gtin: '0' + GTIN13, lot: 'LOT7', expiry: '2027-06-30' });
  });

  it('reports errors', () => {
    expect(parseGs1(']d2').errors).toEqual(['EMPTY']);
    expect(parseGs1(']d299ABC').errors).toEqual(['UNKNOWN_AI_99']);
    expect(parseGs1(`]d201${'1'.repeat(10)}`).errors).toEqual(['BAD_VALUE_01']);
    expect(parseGs1(`]d2010${GTIN13}17271341`).errors).toEqual(['BAD_DATE_17']);
    expect(parseGs1(`]d2010${GTIN13}010${GTIN13}`).errors).toEqual(['DUPLICATE_AI_01']);
    expect(parseGs1(`]d210${'A'.repeat(21)}`).errors).toEqual(['BAD_VALUE_10']);
    expect(parseGs1(`]d210`).errors).toEqual(['BAD_VALUE_10']);
  });

  it('warns on a wrong check digit without refusing', () => {
    const bad = SSCC.slice(0, 17) + ((Number(SSCC[17]) + 1) % 10);
    const parsed = parseGs1(`]d200${bad}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toEqual(['CHECK_DIGIT_00']);
  });

  it('refuses bad encoder input', () => {
    expect(() => encodePalletGs1({ ...pallet, sscc: '123' })).toThrow();
    expect(() => encodePalletGs1({ ...pallet, lot: 'ŞARJ 1' })).toThrow();
    expect(() => encodePalletGs1({ ...pallet, gtin: GTIN13.slice(0, 12) + ((Number(GTIN13[12]) + 1) % 10) })).toThrow(/check digit/);
    expect(normalizeGtin14(GTIN13)).toBe('0' + GTIN13);
  });
});

describe('classifyScan', () => {
  it.each(['TZ-B03-L12', 'TZ-DOCK-01', 'TZ-STG-01', 'TZ-PF-A01'])('classifies %s as a location', (code) => {
    expect(classifyScan(code)).toEqual({ kind: 'location', raw: code, code });
  });

  it('tolerates the Enter suffix, spaces and lower case on locations', () => {
    expect(classifyScan(' tz-b03-l12\r\n')).toMatchObject({ kind: 'location', code: 'TZ-B03-L12' });
  });

  it('classifies a bare 18-digit serial', () => {
    expect(classifyScan(SSCC)).toEqual({ kind: 'pallet_serial', raw: SSCC, serial: SSCC, checkDigitValid: true });
    expect(classifyScan('123456789012345678')).toMatchObject({ kind: 'pallet_serial', checkDigitValid: false });
  });

  it('classifies GS1 strings by function character or symbology identifier', () => {
    const body = `00${SSCC}010${GTIN13}1727113011261119` + '10L1';
    for (const prefix of [GS, ']d2', ']Q3', ']C1']) {
      const scan = classifyScan(prefix + body, { now: NOW });
      expect(scan.kind).toBe('gs1');
      expect(palletSerialOf(scan)).toBe(SSCC);
    }
    // Without a function character or identifier the same digits are not GS1.
    expect(classifyScan(body).kind).toBe('unknown');
  });

  it('returns unknown for everything else', () => {
    expect(classifyScan('')).toMatchObject({ kind: 'unknown', reason: 'empty' });
    expect(classifyScan('\r\n')).toMatchObject({ kind: 'unknown', reason: 'empty' });
    expect(classifyScan('HELLO')).toMatchObject({ kind: 'unknown', reason: 'unrecognised' });
    expect(classifyScan('12345678901234567')).toMatchObject({ kind: 'unknown' }); // 17 digits
    expect(classifyScan('1234567890123456789')).toMatchObject({ kind: 'unknown' }); // 19 digits
    expect(classifyScan('T-B03-L12')).toMatchObject({ kind: 'unknown' });
    expect(classifyScan('TZ-B03')).toMatchObject({ kind: 'unknown' });
    expect(classifyScan('TZ-B03-L12-X')).toMatchObject({ kind: 'unknown' });
    expect(classifyScan('8691234500017')).toMatchObject({ kind: 'unknown' }); // bare EAN-13
    expect(classifyScan(']d299XYZ')).toMatchObject({ kind: 'unknown', reason: 'gs1_invalid', errors: ['UNKNOWN_AI_99'] });
    expect(palletSerialOf(classifyScan('TZ-B03-L12'))).toBeNull();
  });
});
