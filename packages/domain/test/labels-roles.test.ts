import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLOOR_SCREENS,
  GS,
  LABEL_TEMPLATES,
  OFFICE_SCREENS,
  ROLES,
  buildSscc,
  can,
  canSee,
  classifyScan,
  escapeZplField,
  floorScreensFor,
  formatDateTr,
  formatKgTr,
  gs1CheckDigit,
  homePathFor,
  labelTokens,
  officeScreensFor,
  renderLabel,
  renderLabelRequest,
} from '../src';
import { generatedTemplatesSource } from '../scripts/gen';

const SSCC = buildSscc({ extensionDigit: 0, companyPrefix: '8691234', serialReference: 77 });
const GTIN = '869123450001' + gs1CheckDigit('869123450001');

describe('renderLabel', () => {
  it('fills tokens and escapes ZPL control characters', () => {
    expect(renderLabel('^FH\\^FD{{a}}^FS^PQ{{copies}}', { a: 'x^y~z\\w' })).toBe('^FH\\^FDx\\5Ey\\7Ez\\5Cw^FS^PQ1');
    expect(renderLabel('{{a|bx}}', { a: 'L_1' })).toBe('L__1');
    expect(escapeZplField('Şeffaf ğüşiöç İI')).toBe('Şeffaf ğüşiöç İI');
  });

  it('throws on a missing value', () => {
    expect(() => renderLabel('{{a}} {{b}}', { a: 1 })).toThrow(/missing values: b/);
  });

  it('formats Turkish dates and weights', () => {
    expect(formatDateTr('2027-11-30')).toBe('30.11.2027');
    expect(formatKgTr(612.5)).toBe('612,5');
    expect(formatKgTr(600)).toBe('600');
  });
});

describe('label templates', () => {
  it('generated copy matches /labels/*.zpl', () => {
    const onDisk = readFileSync(join(__dirname, '..', 'src', 'labels', 'templates.generated.ts'), 'utf8');
    expect(onDisk).toBe(generatedTemplatesSource());
  });

  it.each(Object.keys(LABEL_TEMPLATES))('%s is a UTF-8 ZPL format', (name) => {
    const t = LABEL_TEMPLATES[name as keyof typeof LABEL_TEMPLATES];
    expect(t.startsWith('^XA')).toBe(true);
    expect(t.trimEnd().endsWith('^XZ')).toBe(true);
    expect(t).toContain('^CI28');
    expect(labelTokens(t)).toContain('copies');
  });

  it('renders the pallet label with a scannable GS1 payload', () => {
    const { zpl } = renderLabelRequest({
      template: 'pallet',
      copies: 2,
      data: {
        sscc: SSCC,
        gtin: GTIN,
        sku: 'DYS-PU-BEYAZ-600ML',
        description: 'Dayson PU Mastik Beyaz 600 ml Sosis – Şeffaf ambalaj',
        lot: 'L26K1901',
        expiry: '2027-11-30',
        production_date: '2026-11-19',
        pallet_kg: 612.5,
      },
    });
    expect(zpl).not.toMatch(/\{\{/);
    expect(zpl).toContain('^PW800');
    expect(zpl).toContain('^LL1200');
    expect(zpl).toContain('^BXN');
    expect(zpl).toContain('^PQ2,');
    expect(zpl).toContain('DYS-PU-BEYAZ-600ML');
    expect(zpl).toContain('Şeffaf ambalaj');
    expect(zpl).toContain('L26K1901');
    expect(zpl).toContain('30.11.2027');
    expect(zpl).toContain('612,5 kg');
    const payload = /\^FD_1([^\^]+)\^FS/.exec(zpl)![1];
    const scan = classifyScan(']d2' + payload, { now: new Date('2026-11-23T00:00:00Z') });
    expect(scan).toMatchObject({
      kind: 'gs1',
      data: { sscc: SSCC, gtin: '0' + GTIN, expiry: '2027-11-30', productionDate: '2026-11-19', lot: 'L26K1901' },
    });
  });

  it('renders the location label as Code 128', () => {
    const { zpl } = renderLabelRequest({ template: 'location', data: { code: 'TZ-B03-L12' } });
    expect(zpl).toContain('^BCR');
    expect(zpl.match(/TZ-B03-L12/g)).toHaveLength(2);
    expect(zpl).toContain('^PQ1,');
    expect(zpl).toContain('^FO110,238');
  });

  it('renders the carton label as QR with a leading GS', () => {
    const { zpl } = renderLabelRequest({ template: 'carton', data: { gtin: GTIN, sku: 'DYS-MB-GRI-48MM', lot: 'L1', expiry: '2027-06-30' } });
    expect(zpl).toContain('^PW480');
    expect(zpl).toContain('^BQN');
    const payload = /\^FDMA,\\1D([^\^]+)\^FS/.exec(zpl)![1];
    expect(classifyScan(GS + payload, { now: new Date('2026-11-23T00:00:00Z') })).toMatchObject({
      kind: 'gs1',
      data: { gtin: '0' + GTIN, expiry: '2027-06-30', lot: 'L1' },
    });
    expect(classifyScan(']Q1' + payload).kind).toBe('gs1');
  });

  it('refuses bad label requests', () => {
    expect(() => renderLabelRequest({ template: 'location', data: { code: 'not a code' } })).toThrow();
    expect(() => renderLabelRequest({ template: 'pallet', data: {} })).toThrow();
    expect(() => renderLabelRequest({ template: 'location', data: { code: 'TZ-B03-L12' }, copies: 500 })).toThrow();
    expect(() => renderLabelRequest({ template: 'other', data: {} })).toThrow();
  });
});

describe('roles', () => {
  it('has the eight roles of section 12.1', () => {
    expect(ROLES).toEqual(['owner', 'ops_manager', 'operator', 'qc', 'planner', 'sales_rep', 'finance', 'auditor']);
  });

  it('maps screens per role', () => {
    expect(officeScreensFor('owner')).toEqual([...OFFICE_SCREENS]);
    expect(floorScreensFor('owner')).toEqual([...FLOOR_SCREENS]);
    expect(officeScreensFor('operator')).toEqual([]);
    expect(floorScreensFor('operator')).not.toContain('qc');
    expect(floorScreensFor('qc')).toEqual(['tasks', 'qc', 'query']);
    expect(canSee('auditor', 'office.audit')).toBe(true);
    expect(canSee('planner', 'office.audit')).toBe(false);
    expect(canSee('finance', 'office.reconciliation')).toBe(true);
    expect(floorScreensFor('finance')).toEqual([]);
    expect(floorScreensFor('auditor')).toEqual([]);
    expect(canSee(null, 'office.dashboard')).toBe(false);
  });

  it('maps capabilities', () => {
    expect(can('owner', 'params.publish')).toBe(true);
    expect(can('ops_manager', 'params.publish')).toBe(false);
    expect(can('planner', 'campaign.approve')).toBe(false);
    expect(can('finance', 'stock.post')).toBe(false);
    expect(can('auditor', 'audit.read')).toBe(true);
    expect(can('operator', 'stock.adjust.approve')).toBe(false);
  });

  it('picks a landing page', () => {
    expect(homePathFor('operator')).toBe('/floor');
    expect(homePathFor('owner')).toBe('/dashboard');
    expect(homePathFor('sales_rep')).toBe('/orders');
    expect(homePathFor(null)).toBe('/login');
  });
});
