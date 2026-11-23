import { describe, expect, it } from 'vitest';
import { MECHANIC_CODES, MECHANICS, explodeOrderLine, getMechanic, mechanics, validateMechanicParams } from '../src';

const line = { id: 'line-1', item_id: 'item-pu-white', qty: 35, unit_price_eur: 3.65 };

describe('registry', () => {
  it('has the eight v1 mechanics, each with its own code', () => {
    expect(MECHANIC_CODES).toEqual([
      'price_discount', 'volume_tier', 'buy_x_get_y', 'mixed_set', 'gift_item', 'target_rebate', 'launch_seed', 'export_push',
    ]);
    for (const code of MECHANIC_CODES) expect(MECHANICS[code].code).toBe(code);
    expect(getMechanic('nope')).toBeNull();
    expect(validateMechanicParams('nope', {})).toEqual(['unknown mechanic: nope']);
    expect(() => explodeOrderLine('nope', line, {})).toThrow();
  });
});

describe('buy_x_get_y', () => {
  const params = { buy_item_rule: { item_ids: ['item-pu-white'] }, buy_qty: 10, free_item: 'same', free_qty: 1 };

  it('buy 10 get 1 on 35 units gives 3 free', () => {
    expect(explodeOrderLine('buy_x_get_y', line, params)).toEqual([
      { item_id: 'item-pu-white', qty: 3, line_type: 'free', parent_line_id: 'line-1' },
    ]);
  });

  it('gives nothing below the first multiple', () => {
    expect(explodeOrderLine('buy_x_get_y', { ...line, qty: 9 }, params)).toEqual([]);
  });

  it('honours max_per_order, including units already granted', () => {
    expect(explodeOrderLine('buy_x_get_y', { ...line, qty: 120 }, { ...params, max_per_order: 5 })[0].qty).toBe(5);
    expect(explodeOrderLine('buy_x_get_y', line, { ...params, max_per_order: 5 }, { free_qty_already_granted: 4 })[0].qty).toBe(1);
    expect(explodeOrderLine('buy_x_get_y', line, { ...params, max_per_order: 5 }, { free_qty_already_granted: 5 })).toEqual([]);
  });

  it('can give another item and several units per multiple', () => {
    expect(explodeOrderLine('buy_x_get_y', line, { ...params, free_item: 'item-tape', free_qty: 2 })).toEqual([
      { item_id: 'item-tape', qty: 6, line_type: 'free', parent_line_id: 'line-1' },
    ]);
  });

  it('applies the item rule', () => {
    expect(explodeOrderLine('buy_x_get_y', { ...line, item_id: 'other' }, params)).toEqual([]);
    const family = { ...params, buy_item_rule: { family_code: 'PU', attrs: { volume_ml: 600 } } };
    expect(explodeOrderLine('buy_x_get_y', line, family, { item: { item_id: line.item_id, family_code: 'PU', attrs: { volume_ml: 600 } } })).toHaveLength(1);
    expect(explodeOrderLine('buy_x_get_y', line, family, { item: { item_id: line.item_id, family_code: 'PU', attrs: { volume_ml: 310 } } })).toEqual([]);
    expect(explodeOrderLine('buy_x_get_y', line, family)).toEqual([]);
  });
});

describe('mixed_set', () => {
  it('explodes the bundle line into component lines', () => {
    const out = explodeOrderLine(
      'mixed_set',
      { id: 'line-9', item_id: 'bundle-sku', qty: 4 },
      { bundle_id: 'bundle-1', price: 49.9 },
      { bundle_lines: [{ item_id: 'a', qty: 6 }, { item_id: 'b', qty: 0.5 }, { item_id: 'c', qty: 0 }] },
    );
    expect(out).toEqual([
      { item_id: 'a', qty: 24, line_type: 'bundle_component', parent_line_id: 'line-9' },
      { item_id: 'b', qty: 2, line_type: 'bundle_component', parent_line_id: 'line-9' },
    ]);
  });

  it('adds nothing without bundle lines', () => {
    expect(explodeOrderLine('mixed_set', line, { bundle_id: 'bundle-1', price: 10 })).toEqual([]);
  });
});

describe('gift_item', () => {
  it('adds the gift when threshold_qty is reached', () => {
    const params = { threshold_qty: 30, gift_item: 'gift-cap', qty: 2 };
    expect(explodeOrderLine('gift_item', line, params)).toEqual([
      { item_id: 'gift-cap', qty: 2, line_type: 'free', parent_line_id: 'line-1' },
    ]);
    expect(explodeOrderLine('gift_item', { ...line, qty: 29 }, params)).toEqual([]);
    expect(explodeOrderLine('gift_item', { ...line, qty: 5 }, params, { order_total_qty: 30 })).toHaveLength(1);
    expect(explodeOrderLine('gift_item', line, params, { gift_already_granted: true })).toEqual([]);
  });

  it('adds the gift when threshold_eur is reached', () => {
    const params = { threshold_eur: 100, gift_item: 'gift-cap', qty: 1 };
    expect(explodeOrderLine('gift_item', line, params)).toHaveLength(1); // 35 x 3.65 = 127.75
    expect(explodeOrderLine('gift_item', { ...line, qty: 10 }, params)).toEqual([]);
    expect(explodeOrderLine('gift_item', { ...line, qty: 10 }, params, { order_total_eur: 500 })).toHaveLength(1);
  });
});

describe('mechanics without extra lines', () => {
  it.each([
    ['price_discount', { discount_pct: 10 }],
    ['volume_tier', { tiers: [{ min_qty: 10, discount_pct: 3 }, { min_qty: 50, discount_pct: 5 }] }],
    ['target_rebate', { period: { from: '2026-07-01', to: '2026-09-30' }, targets: { A: 50000 }, rebate_pct: 2 }],
    ['launch_seed', { item: 'item-new', seed_qty: { A: 240, B: 120 } }],
    ['export_push', { market: 'MK', items: ['item-pu-white'], terms: 'CIF, 60 gün vade' }],
  ])('%s', (code, params) => {
    expect(validateMechanicParams(code, params)).toEqual([]);
    expect(explodeOrderLine(code, line, params)).toEqual([]);
  });

  it('volume_tier picks the tier', () => {
    const params = { tiers: [{ min_qty: 10, discount_pct: 3 }, { min_qty: 50, discount_pct: 5 }] };
    expect(mechanics.volumeTier.tierFor(9, params)).toBeNull();
    expect(mechanics.volumeTier.tierFor(35, params)?.discount_pct).toBe(3);
    expect(mechanics.volumeTier.tierFor(50, params)?.discount_pct).toBe(5);
  });
});

describe('each schema rejects bad params', () => {
  const bad: Record<string, unknown[]> = {
    price_discount: [{}, { discount_pct: 0 }, { discount_pct: 101 }, { discount_pct: '10' }, { discount_pct: 10, extra: 1 }],
    volume_tier: [{}, { tiers: [] }, { tiers: [{ min_qty: 50, discount_pct: 5 }, { min_qty: 10, discount_pct: 3 }] }, { tiers: [{ min_qty: -1, discount_pct: 5 }] }],
    buy_x_get_y: [
      {},
      { buy_item_rule: {}, buy_qty: 10, free_item: 'same', free_qty: 1 },
      { buy_item_rule: { item_ids: ['a'] }, buy_qty: 0, free_item: 'same', free_qty: 1 },
      { buy_item_rule: { item_ids: ['a'] }, buy_qty: 10, free_item: '', free_qty: 1 },
      { buy_item_rule: { item_ids: ['a'] }, buy_qty: 10, free_item: 'same', free_qty: 1, max_per_order: -2 },
    ],
    mixed_set: [{}, { bundle_id: '', price: 1 }, { bundle_id: 'b', price: -1 }, { bundle_id: 'b' }],
    gift_item: [
      {},
      { gift_item: 'g', qty: 1 },
      { threshold_qty: 10, threshold_eur: 100, gift_item: 'g', qty: 1 },
      { threshold_qty: 10, gift_item: 'g', qty: 0 },
    ],
    target_rebate: [
      {},
      { period: { from: '2026-09-30', to: '2026-07-01' }, targets: { A: 1 }, rebate_pct: 2 },
      { period: { from: '2026-07-01', to: '2026-09-30' }, targets: {}, rebate_pct: 2 },
      { period: { from: '01.07.2026', to: '2026-09-30' }, targets: { A: 1 }, rebate_pct: 2 },
    ],
    launch_seed: [{}, { item: 'i', seed_qty: {} }, { item: '', seed_qty: { A: 1 } }, { item: 'i', seed_qty: { A: 0 } }],
    export_push: [{}, { market: 'MK', items: [], terms: 'x' }, { market: '', items: ['a'], terms: 'x' }, { market: 'MK', items: ['a'] }],
  };

  it.each(MECHANIC_CODES)('%s', (code) => {
    expect(bad[code].length).toBeGreaterThan(0);
    for (const params of bad[code]) {
      expect(validateMechanicParams(code, params).length, JSON.stringify(params)).toBeGreaterThan(0);
      expect(() => explodeOrderLine(code, line, params)).toThrow();
    }
  });
});
