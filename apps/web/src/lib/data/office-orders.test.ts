import { describe, expect, it } from 'vitest';
import { buildOrderLines, ordersFromSalesDocs, scopeMatchesItem, toBase, toSaveLines, type ItemInfo, type OrderCampaign } from './office-orders';

const item = (id: string, sku: string, family = 'SEAL', attributes: Record<string, unknown> = {}): ItemInfo => ({
  id, sku, base_uom: 'piece', family_code: family, attributes, packs: { piece: 1, carton: 12, pallet: 1200 },
});
const items = new Map([
  ['i1', item('i1', 'DYS-PU-BEYAZ-SOS', 'SEAL', { colour: 'Beyaz' })],
  ['i2', item('i2', 'GRP-TABANCA-600', 'GRP')],
  ['set', item('set', 'SET-USTA-01', 'SET')],
  ['gift', item('gift', 'PROMO-TSHIRT', 'GIFT')],
]);

const bxgy = (params: Record<string, unknown>, scope: Record<string, unknown> = { all: true }): OrderCampaign => ({
  id: 'c1', code: 'K1', name: 'Kampanya', scopes: [{ item_rule: scope }], mechanics: [{ mechanic_type: 'buy_x_get_y', params }], bundles: null,
});

describe('scopeMatchesItem', () => {
  it('follows the database rule dialect', () => {
    const it1 = items.get('i1')!;
    expect(scopeMatchesItem({}, it1)).toBe(true);
    expect(scopeMatchesItem({ all: true }, it1)).toBe(true);
    expect(scopeMatchesItem({ family: 'SEAL' }, it1)).toBe(true);
    expect(scopeMatchesItem({ family: 'TAPE' }, it1)).toBe(false);
    expect(scopeMatchesItem({ item_ids: ['i2'] }, it1)).toBe(false);
    expect(scopeMatchesItem({ attributes: { colour: 'Beyaz' } }, it1)).toBe(true);
    expect(scopeMatchesItem({ skus: ['DYS-PU-BEYAZ-SOS'] }, it1)).toBe(true);
  });
});

describe('toBase', () => {
  it('converts with the pack table and refuses unknown units', () => {
    expect(toBase(items.get('i1')!, 2, 'carton')).toBe(24);
    expect(toBase(items.get('i1')!, 5, 'piece')).toBe(5);
    expect(toBase(items.get('i1')!, 5, 'box')).toBeNull();
  });
});

describe('buildOrderLines', () => {
  it('adds one free line per multiple reached, in base units', () => {
    const c = bxgy({ buy_item_rule: { family_code: 'SEAL' }, buy_qty: 10, free_item: 'same', free_qty: 1 });
    const built = buildOrderLines([{ item_id: 'i1', qty: 3, uom: 'carton' }], items, [c], []);
    expect(built.campaign_id).toBe('c1');
    expect(built.lines).toHaveLength(2);
    expect(built.lines[0]).toMatchObject({ ref: 'L1', line_type: 'paid', qty: 3, uom: 'carton' });
    expect(built.lines[1]).toMatchObject({ parent_ref: 'L1', line_type: 'free', item_id: 'i1', qty: 3, mechanic_code: 'buy_x_get_y' });
  });

  it('respects max_per_order across lines', () => {
    const c = bxgy({ buy_item_rule: { family_code: 'SEAL' }, buy_qty: 10, free_item: 'same', free_qty: 1, max_per_order: 4 });
    const built = buildOrderLines([{ item_id: 'i1', qty: 30, uom: 'piece' }, { item_id: 'i1', qty: 30, uom: 'piece' }], items, [c], []);
    const free = built.lines.filter((l) => l.line_type === 'free');
    expect(free.map((l) => l.qty)).toEqual([3, 1]);
  });

  it('skips a campaign whose scope does not cover the item', () => {
    const c = bxgy({ buy_item_rule: { family_code: 'SEAL' }, buy_qty: 1, free_item: 'same', free_qty: 1 }, { family: 'TAPE' });
    const built = buildOrderLines([{ item_id: 'i1', qty: 30, uom: 'piece' }], items, [c], []);
    expect(built.lines).toHaveLength(1);
    expect(built.campaign_id).toBeNull();
  });

  it('expands a phantom bundle into components once', () => {
    const bundles = [{ id: 'b1', item_id: 'set', kind: 'phantom', lines: [{ item_id: 'i1', qty: 6 }, { item_id: 'i2', qty: 1 }] }];
    const c: OrderCampaign = {
      id: 'c2', code: 'SET', name: 'Set', scopes: [{ item_rule: {} }], mechanics: [{ mechanic_type: 'mixed_set', params: { bundle_id: 'b1', price: 50 } }],
      bundles: [{ bundle_id: 'b1', item_id: 'set', kind: 'phantom', lines: bundles[0].lines }],
    };
    const built = buildOrderLines([{ item_id: 'set', qty: 2, uom: 'piece' }], items, [c], bundles);
    const comp = built.lines.filter((l) => l.line_type === 'bundle_component');
    expect(comp.map((l) => [l.item_id, l.qty])).toEqual([['i1', 12], ['i2', 2]]);
    expect(comp.every((l) => l.parent_ref === 'L1' && l.bundle_id === 'b1')).toBe(true);
    expect(built.lines[0].mechanic_code).toBe('mixed_set');
  });

  it('grants a gift once per order and reports bad params', () => {
    const gift: OrderCampaign = { id: 'c3', code: 'G', name: 'G', scopes: null, mechanics: [{ mechanic_type: 'gift_item', params: { threshold_qty: 50, gift_item: 'gift', qty: 1 } }, { mechanic_type: 'buy_x_get_y', params: { buy_qty: -1 } }], bundles: null };
    const built = buildOrderLines([{ item_id: 'i1', qty: 30, uom: 'piece' }, { item_id: 'i2', qty: 30, uom: 'piece' }], items, [gift], []);
    expect(built.lines.filter((l) => l.item_id === 'gift')).toHaveLength(1);
    expect(built.warnings.some((w) => w.startsWith('INVALID_PARAMS:G:buy_x_get_y'))).toBe(true);
  });

  it('puts discount terms on the paid line and strips display keys', () => {
    const c: OrderCampaign = { id: 'c4', code: 'D', name: 'D', scopes: null, mechanics: [{ mechanic_type: 'price_discount', params: { discount_pct: 10 } }], bundles: null };
    const built = buildOrderLines([{ item_id: 'i1', qty: 1, uom: 'piece' }], items, [c], []);
    expect(built.lines[0].terms).toEqual({ campaign_code: 'D', discount_pct: 10 });
    expect(toSaveLines(built.lines)[0]).not.toHaveProperty('campaign_code');
  });

  it('warns on an unknown unit', () => {
    const built = buildOrderLines([{ item_id: 'i1', qty: 1, uom: 'box' }], items, [], []);
    expect(built.warnings).toEqual(['UOM_UNKNOWN:DYS-PU-BEYAZ-SOS:box']);
  });
});

describe('ordersFromSalesDocs', () => {
  it('groups rows by document and reports unknown codes', () => {
    const rows = [
      { doc_no: 'S1', doc_date: '2026-12-01', logo_cari_code: '120.01.001', logo_item_code: 'A', qty: '10', unit: 'KOLI', is_free: 'false' },
      { doc_no: 'S1', doc_date: '2026-12-01', logo_cari_code: '120.01.001', logo_item_code: 'A', qty: '1', unit: 'ADET', is_free: 'true' },
      { doc_no: 'S2', doc_date: '2026-12-02', logo_cari_code: 'X', logo_item_code: 'B', qty: '1', unit: 'ADET', is_free: 'false' },
    ];
    const orders = ordersFromSalesDocs(rows, new Map([['120.01.001', 'p1']]), new Map([['A', 'i1']]), new Map([['i1|KOLI', 'carton'], ['i1|ADET', 'piece']]));
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ doc_no: 'S1', party_id: 'p1', hasFreeLines: true, errors: [] });
    expect(orders[0].lines).toEqual([{ item_id: 'i1', qty: 10, uom: 'carton', line_type: 'paid' }, { item_id: 'i1', qty: 1, uom: 'piece', line_type: 'free' }]);
    expect(orders[1].errors).toEqual(['UNKNOWN_PARTY:X', 'UNKNOWN_ITEM:B']);
  });
});
