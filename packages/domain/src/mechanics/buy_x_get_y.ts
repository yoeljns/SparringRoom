import { z } from 'zod';
import { itemRuleSchema, matchesItemRule } from './item-rule';
import { roundQty, type Mechanic } from './types';

export const code = 'buy_x_get_y';

/** free_item "same" gives the ordered item itself. */
export const SAME_ITEM = 'same';

export const paramsSchema = z.strictObject({
  buy_item_rule: itemRuleSchema,
  buy_qty: z.number().positive(),
  free_item: z.string().min(1),
  free_qty: z.number().positive(),
  /** Cap on free units per order; null or absent = no cap. */
  max_per_order: z.number().positive().nullable().optional(),
});
export type Params = z.infer<typeof paramsSchema>;

/**
 * One free line per multiple reached: buy 10 get 1 on 35 units gives 3 free.
 * max_per_order caps the free units of the whole order; units already granted
 * on other lines arrive in ctx.free_qty_already_granted.
 */
export const explode: Mechanic<Params>['explode'] = (orderLine, params, ctx = {}) => {
  if (!matchesItemRule(params.buy_item_rule, orderLine.item_id, ctx.item)) return [];
  const multiples = Math.floor(orderLine.qty / params.buy_qty);
  if (multiples <= 0) return [];
  let freeQty = multiples * params.free_qty;
  if (params.max_per_order != null) {
    const room = params.max_per_order - (ctx.free_qty_already_granted ?? 0);
    freeQty = Math.min(freeQty, room);
  }
  freeQty = roundQty(freeQty);
  if (freeQty <= 0) return [];
  return [
    {
      item_id: params.free_item === SAME_ITEM ? orderLine.item_id : params.free_item,
      qty: freeQty,
      line_type: 'free',
      parent_line_id: orderLine.id,
    },
  ];
};

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
