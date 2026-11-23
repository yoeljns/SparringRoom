import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import tr from '@/i18n/tr.json';
import { ApiError, parseServerMessage } from '@/lib/data/office-db';
import { schemaFor, toFormValues, validateForm, type FieldDef } from './Form';
import { E, L, T, errText, fDate, fDateTime, fEur, fNum, fPct, fRatio } from './i18n';
import { parseAttrs } from './SchemaForm';
import { diffRows } from './screens/AuditScreen';
import { scopeFromDb, scopeToDb } from './screens/CampaignsScreen';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function has(key: string): boolean {
  let node: unknown = tr.office;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

describe('office i18n', () => {
  const files = [...walk(path.resolve(__dirname)), ...walk(path.resolve(__dirname, '../../app/(office)'))].filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));
  const source = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  it('has a Turkish string for every literal key used on the screens', () => {
    const keys = [...new Set([...source.matchAll(/\bT\('([^']+)'/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThan(500);
    expect(keys.filter((k) => !has(k))).toEqual([]);
  });

  it('has a label for every table column and form field', () => {
    const cols = [...new Set([...source.matchAll(/\bkey: '([a-z_0-9]+)'/g)].map((m) => m[1]))];
    expect(cols.filter((c) => !has(`col.${c}`))).toEqual([]);
  });

  it('translates every documented server error code', () => {
    const api = fs.readFileSync(path.resolve(__dirname, '../../../../../docs/api.md'), 'utf8');
    const block = /- Codes: ([\s\S]*?)\n\n/.exec(api)?.[1] ?? '';
    const codes = [...block.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(30);
    expect(codes.filter((c) => !has(`err.${c}`))).toEqual([]);
  });

  it('falls back visibly for unknown keys and plainly for unknown columns and values', () => {
    expect(T('nope.nope')).toBe('⟦nope.nope⟧');
    expect(L('some_new_column')).toBe('some_new_column');
    expect(E('some_new_state')).toBe('some_new_state');
    expect(E(null)).toBe('—');
    expect(E('quarantine')).toBe('Karantina');
  });
});

describe('formatting', () => {
  it('uses Turkish number format and DD.MM.YYYY in Europe/Istanbul', () => {
    expect(fNum(12345.678)).toBe('12.345,678');
    expect(fNum('3600.000')).toBe('3.600');
    expect(fNum(null)).toBe('—');
    expect(fPct(98.456)).toBe('%98,46');
    expect(fRatio(0.975)).toBe('%97,5');
    expect(fEur(83520)).toBe('83.520 €');
    expect(fDate('2026-11-23')).toBe('23.11.2026');
    // 22:30 UTC is already the next day in Istanbul (UTC+3).
    expect(fDate('2026-11-23T22:30:00Z')).toBe('24.11.2026');
    expect(fDateTime('2026-11-23T22:30:00Z')).toBe('24.11.2026 01:30');
  });
});

describe('server errors', () => {
  it('splits "CODE: detail" and translates the code', () => {
    const e = parseServerMessage('INVALID_SKU: X-1 does not match the SEAL pattern');
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('INVALID_SKU');
    expect(errText(e)).toBe('Stok kodu aile kalıbına uymuyor. (INVALID_SKU: X-1 does not match the SEAL pattern)');
    expect(errText(new ApiError('SOMETHING_NEW', ''))).toBe('İşlem tamamlanamadı. (SOMETHING_NEW)');
    expect(parseServerMessage('duplicate key value', '23505').code).toBe('23505');
  });
});

describe('generated form schema', () => {
  const fields: FieldDef[] = [
    { key: 'name', required: true }, { key: 'qty', type: 'number', required: true, min: 1 }, { key: 'n', type: 'int' }, { key: 'on', type: 'bool' },
    { key: 'day', type: 'date' }, { key: 'extra', type: 'json' }, { key: 'dealer', show: (v) => v.on === true, required: true },
  ];
  it('converts strings to typed values and empty optionals to null', () => {
    const values = toFormValues(fields, { name: ' Ürün ', qty: 2.5, on: false, extra: { a: 1 } });
    const { data, errors } = validateForm(fields, { ...values, qty: '2,5' });
    expect(errors).toEqual({});
    expect(data).toEqual({ name: 'Ürün', qty: 2.5, n: null, on: false, day: null, extra: { a: 1 } });
  });
  it('reports required, numeric, minimum and JSON errors in Turkish', () => {
    const { data, errors } = validateForm(fields, { name: '', qty: '0', n: '1.5', on: true, day: '', extra: '{bad', dealer: '' });
    expect(data).toBeUndefined();
    expect(errors).toEqual({ name: 'Bu alan zorunlu.', qty: 'En az 1 olmalı.', n: 'Geçerli bir sayı girin.', extra: 'Geçerli JSON girin.', dealer: 'Bu alan zorunlu.' });
  });
  it('builds a zod schema', () => {
    expect(schemaFor(fields).safeParse({ name: 'a', qty: '1', n: '', on: true, day: '2026-01-01', extra: '', dealer: 'x' }).success).toBe(true);
  });
});

describe('rules and diffs', () => {
  it('parses attribute filters with types', () => {
    expect(parseAttrs('colour=Beyaz, volume_ml=600, ok=true')).toEqual({ colour: 'Beyaz', volume_ml: 600, ok: true });
    expect(parseAttrs('  ')).toBeUndefined();
  });
  it('round-trips campaign scope rules in the database dialect', () => {
    const db = { item_rule: { family: 'SEAL' }, party_rule: { segments: ['A', 'B'] }, market_ids: ['m1'] };
    expect(scopeToDb(scopeFromDb(db))).toEqual(db);
    expect(scopeToDb(scopeFromDb({ item_rule: { all: true }, party_rule: {}, market_ids: null }))).toEqual({ item_rule: { all: true }, party_rule: { all: true } });
    expect(scopeToDb(scopeFromDb({ item_rule: { attributes: { colour: 'Gri' } }, party_rule: { party_ids: ['p'] } }))).toEqual({ item_rule: { attributes: { colour: 'Gri' } }, party_rule: { party_ids: ['p'] } });
  });
  it('lists changed fields between old and new audit rows', () => {
    expect(diffRows({ a: 1, b: { x: 1 }, updated_at: 't1' }, { a: 2, b: { x: 1 }, c: 'yeni', updated_at: 't2' })).toEqual([{ key: 'a', before: 1, after: 2 }, { key: 'c', before: undefined, after: 'yeni' }]);
    expect(diffRows(null, { a: 1 })).toEqual([{ key: 'a', before: undefined, after: 1 }]);
  });
});
