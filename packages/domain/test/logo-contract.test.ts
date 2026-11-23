import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOGO_CONTRACTS,
  LOGO_FILE_TYPES,
  LOGO_INBOUND_TYPES,
  LOGO_OUTBOUND_TYPES,
  buildLogoFile,
  logoColumnNames,
  logoContractJson,
  logoFileName,
  parseLogoFile,
  parseLogoFileName,
  sha256Hex,
  splitCsv,
} from '../src';

const CONTRACTS_DIR = join(__dirname, '..', '..', '..', 'contracts');

const ITEMS_OK = [
  '#schema=v1',
  'logo_item_code;name;unit;gtin;active',
  'DYS-PU-BEYAZ-600ML;Dayson PU Mastik Beyaz 600 ml;ADET;8691234500017;true',
  'DYS-MB-GRI-48MM;"Bant; Gri ""48"" mm";RULO;;0',
  '',
].join('\n');

describe('column lists follow sections 11.2 and 11.3', () => {
  it('inbound', () => {
    expect(LOGO_INBOUND_TYPES).toEqual(['items', 'parties', 'sales_docs', 'purchase_docs', 'stock_snapshot', 'item_cost']);
    expect(logoColumnNames('items')).toEqual(['logo_item_code', 'name', 'unit', 'gtin', 'active']);
    expect(logoColumnNames('parties')).toEqual(['logo_cari_code', 'name', 'vkn', 'type', 'city', 'country', 'active']);
    expect(logoColumnNames('sales_docs')).toEqual([
      'doc_type', 'doc_no', 'doc_date', 'logo_cari_code', 'logo_item_code', 'qty', 'unit', 'unit_price_eur', 'is_free',
      'e_irsaliye_no', 'ref_shipment_id',
    ]);
    expect(logoColumnNames('purchase_docs')).toEqual(['doc_no', 'doc_date', 'logo_cari_code', 'logo_item_code', 'qty', 'unit']);
    expect(logoColumnNames('stock_snapshot')).toEqual(['as_of', 'logo_item_code', 'warehouse_code', 'qty', 'unit']);
    expect(logoColumnNames('item_cost')).toEqual(['logo_item_code', 'cost_eur', 'as_of']);
  });

  it('outbound', () => {
    expect(LOGO_OUTBOUND_TYPES).toEqual(['shipment_confirm', 'receipts', 'adjustments', 'consignment_sales', 'campaign_settlement']);
    expect(logoColumnNames('shipment_confirm')).toEqual([
      'shipment_id', 'ship_date', 'logo_cari_code', 'logo_item_code', 'qty', 'unit', 'lot_no', 'line_type', 'campaign_code',
    ]);
    expect(logoColumnNames('receipts')).toEqual(['receipt_id', 'date', 'supplier_code', 'logo_item_code', 'qty', 'lot_no']);
    expect(logoColumnNames('adjustments')).toEqual(['txn_id', 'date', 'logo_item_code', 'qty_signed', 'reason_code', 'approved_by']);
    expect(logoColumnNames('consignment_sales')).toEqual(['dealer_code', 'logo_item_code', 'qty', 'period']);
    expect(logoColumnNames('campaign_settlement')).toEqual(['campaign_code', 'dealer_code', 'type', 'amount_eur', 'qty']);
  });
});

describe('file names', () => {
  it('parses <type>_<YYYYMMDD>_<seq>.csv', () => {
    expect(parseLogoFileName('sales_docs_20261123_001.csv')).toEqual({ type: 'sales_docs', date: '2026-11-23', seq: 1 });
    expect(parseLogoFileName('logo-in/items_20261123_12.csv')).toEqual({ type: 'items', date: '2026-11-23', seq: 12 });
    expect(logoFileName('item_cost', '2026-11-23', 7)).toBe('item_cost_20261123_007.csv');
  });

  it.each(['items.csv', 'items_2026-11-23_1.csv', 'unknown_20261123_1.csv', 'items_20261323_1.csv', 'items_20261123_1.txt', 'ITEMS_20261123_1.csv'])(
    'rejects %s',
    (name) => {
      expect(parseLogoFileName(name)).toBeNull();
    },
  );
});

describe('parseLogoFile', () => {
  it('parses a good file', () => {
    const f = parseLogoFile('items_20261123_001.csv', ITEMS_OK);
    expect(f.ok).toBe(true);
    expect(f.rejected).toBe(false);
    expect(f).toMatchObject({ type: 'items', date: '2026-11-23', seq: 1, schemaVersion: 'v1', errors: [] });
    expect(f.header).toEqual(['logo_item_code', 'name', 'unit', 'gtin', 'active']);
    expect(f.rows).toEqual([
      { logo_item_code: 'DYS-PU-BEYAZ-600ML', name: 'Dayson PU Mastik Beyaz 600 ml', unit: 'ADET', gtin: '8691234500017', active: 'true' },
      { logo_item_code: 'DYS-MB-GRI-48MM', name: 'Bant; Gri "48" mm', unit: 'RULO', gtin: '', active: '0' },
    ]);
  });

  it('accepts a BOM, CRLF and a different column order', () => {
    const text = '﻿#schema=v1\r\nactive;logo_item_code;name;unit;gtin\r\ntrue;A-1;Ürün;ADET;\r\n';
    const f = parseLogoFile('items_20261123_002.csv', text);
    expect(f.ok).toBe(true);
    expect(f.rows).toEqual([{ active: 'true', logo_item_code: 'A-1', name: 'Ürün', unit: 'ADET', gtin: '' }]);
  });

  it('rejects the whole file on an unknown column', () => {
    const text = ITEMS_OK.replace('gtin;active', 'gtin;active;colour').replace(';true', ';true;red').replace(';;0', ';;0;grey');
    const f = parseLogoFile('items_20261123_001.csv', text);
    expect(f.ok).toBe(false);
    expect(f.rejected).toBe(true);
    expect(f.rows).toEqual([]);
    expect(f.errors).toEqual([expect.objectContaining({ level: 'file', code: 'UNKNOWN_COLUMN', column: 'colour' })]);
  });

  it('rejects the whole file on a missing column', () => {
    const text = '#schema=v1\nlogo_item_code;name;unit;active\nA-1;X;ADET;true\n';
    const f = parseLogoFile('items_20261123_001.csv', text);
    expect(f.rejected).toBe(true);
    expect(f.rows).toEqual([]);
    expect(f.errors).toEqual([expect.objectContaining({ level: 'file', code: 'MISSING_COLUMN', column: 'gtin' })]);
  });

  it('rejects the whole file on an unknown schema version', () => {
    const f = parseLogoFile('items_20261123_001.csv', ITEMS_OK.replace('#schema=v1', '#schema=v2'));
    expect(f.rejected).toBe(true);
    expect(f.schemaVersion).toBe('v2');
    expect(f.rows).toEqual([]);
    expect(f.errors).toEqual([expect.objectContaining({ level: 'file', code: 'UNKNOWN_SCHEMA_VERSION' })]);
  });

  it('rejects a missing schema line, a bad name and a missing header', () => {
    expect(parseLogoFile('items_20261123_001.csv', ITEMS_OK.split('\n').slice(1).join('\n')).errors[0].code).toBe('MISSING_SCHEMA_LINE');
    expect(parseLogoFile('stuff.csv', ITEMS_OK).errors[0].code).toBe('BAD_FILE_NAME');
    expect(parseLogoFile('items_20261123_001.csv', '#schema=v1\n').errors[0].code).toBe('MISSING_HEADER');
    expect(parseLogoFile('items_20261123_001.csv', '').rejected).toBe(true);
  });

  it('reports row errors with line numbers and keeps the file for review', () => {
    const text = [
      '#schema=v1',
      'doc_no;doc_date;logo_cari_code;logo_item_code;qty;unit',
      'ALM1;2026-11-18;320.01.0005;SIA-DISK-150-15D-P240;400;KUTU',
      'ALM2;18.11.2026;320.01.0005;SIA-DISK-150-15D-P240;12,5;KUTU',
      'ALM3;2026-11-18;;SIA-DISK-150-15D-P240;1;KUTU;extra',
      'ALM4;2026-11-18;;SIA-DISK-150-15D-P240;1;KUTU',
    ].join('\n');
    const f = parseLogoFile('purchase_docs_20261123_001.csv', text);
    expect(f.ok).toBe(false);
    expect(f.rejected).toBe(false);
    expect(f.errors).toEqual([
      expect.objectContaining({ level: 'row', line: 4, column: 'doc_date', code: 'BAD_DATE' }),
      expect.objectContaining({ level: 'row', line: 4, column: 'qty', code: 'BAD_DECIMAL' }),
      expect.objectContaining({ level: 'row', line: 5, code: 'WRONG_CELL_COUNT' }),
      expect.objectContaining({ level: 'row', line: 6, column: 'logo_cari_code', code: 'REQUIRED' }),
    ]);
  });

  it('validates enums, booleans, periods and date-times', () => {
    const bad = parseLogoFile(
      'campaign_settlement_20261123_001.csv',
      '#schema=v1\ncampaign_code;dealer_code;type;amount_eur;qty\nC1;D1;bonus;1e3;\n',
    );
    expect(bad.errors.map((e) => e.code)).toEqual(['BAD_ENUM', 'BAD_DECIMAL']);
    const period = parseLogoFile('consignment_sales_20261123_001.csv', '#schema=v1\ndealer_code;logo_item_code;qty;period\nD1;A;1;2026-13\n');
    expect(period.errors.map((e) => e.code)).toEqual(['BAD_PERIOD']);
    const snap = parseLogoFile(
      'stock_snapshot_20261123_001.csv',
      '#schema=v1\nas_of;logo_item_code;warehouse_code;qty;unit\n2026-11-22;A;W;1;ADET\n2026-11-22T21:00:00+03:00;A;W;1.5;ADET\n2026-11-22 21:00;A;W;1;ADET\n',
    );
    expect(snap.errors.map((e) => [e.line, e.code])).toEqual([[5, 'BAD_DATETIME']]);
  });
});

describe('buildLogoFile', () => {
  it('writes schema line, header and rows, and round-trips', () => {
    const file = buildLogoFile('adjustments', '2026-11-23', 3, [
      { txn_id: 'T1', date: '2026-11-21', logo_item_code: 'DYS-MB-GRI-48MM', qty_signed: -36.5, reason_code: 'COUNT;VARIANCE', approved_by: null },
    ]);
    expect(file.name).toBe('adjustments_20261123_003.csv');
    expect(file.text).toBe(
      '#schema=v1\ntxn_id;date;logo_item_code;qty_signed;reason_code;approved_by\nT1;2026-11-21;DYS-MB-GRI-48MM;-36.5;"COUNT;VARIANCE";\n',
    );
    const parsed = parseLogoFile(file.name, file.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows[0].reason_code).toBe('COUNT;VARIANCE');
  });

  it('throws on an unknown column or a bad value', () => {
    expect(() => buildLogoFile('receipts', '2026-11-23', 1, [{ receipt_id: 'R', colour: 'red' }])).toThrow(/unknown column colour/);
    expect(() =>
      buildLogoFile('receipts', '2026-11-23', 1, [
        { receipt_id: 'R', date: '23.11.2026', supplier_code: 'S', logo_item_code: 'A', qty: 1, lot_no: 'L' },
      ]),
    ).toThrow(/date: BAD_DATE/);
    expect(() => buildLogoFile('receipts', '2026-11-23', 1, [{ receipt_id: 'R' }])).toThrow(/REQUIRED/);
  });
});

describe('sha256Hex', () => {
  it('hashes UTF-8 text', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('ğ')).not.toBe(await sha256Hex('g'));
  });
});

describe('splitCsv', () => {
  it('handles quotes, embedded newlines and blank lines', () => {
    expect(splitCsv('a;b\n\n"x\ny";"q""r"\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['x\ny', 'q"r'] },
    ]);
  });
});

describe('/contracts is in sync with the code', () => {
  it.each(LOGO_FILE_TYPES)('v1/%s.json', (type) => {
    const onDisk = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'v1', `${type}.json`), 'utf8'));
    expect(onDisk).toEqual(logoContractJson(type));
    expect(onDisk.columns.map((c: { name: string }) => c.name)).toEqual(LOGO_CONTRACTS[type].columns.map((c) => c.name));
  });

  it('has one valid sample per file type', () => {
    const files = readdirSync(join(CONTRACTS_DIR, 'samples')).filter((f) => f.endsWith('.csv'));
    const types = new Set<string>();
    for (const name of files) {
      const parsed = parseLogoFile(name, readFileSync(join(CONTRACTS_DIR, 'samples', name), 'utf8'));
      expect(parsed.errors, name).toEqual([]);
      expect(parsed.rows.length, name).toBeGreaterThan(0);
      types.add(parsed.type!);
    }
    expect([...types].sort()).toEqual([...LOGO_FILE_TYPES].sort());
  });
});
