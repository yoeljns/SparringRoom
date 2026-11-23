import { z } from 'zod';
import { roundQty, type Mechanic } from './types';

export const code = 'gift_item';

export const paramsSchema = z
  .strictObject({
    threshold_eur: z.number().positive().nullable().optional(),
    threshold_qty: z.number().positive().nullable().optional(),
    /** A stocked item with sellable = false. */
    gift_item: z.string().min(1),
    qty: z.number().positive(),
  })
  .refine((p) => (p.threshold_eur != null) !== (p.threshold_qty != null), {
    message: 'exactly one of threshold_eur and threshold_qty is required',
  });
export type Params = z.infer<typeof paramsSchema>;

/**
 * One free line of the gift item when the threshold is reached. The gift is
 * granted once per order: pass ctx.gift_already_granted for later lines.
 * Order totals come from ctx; without them the single line is measured.
 */
export const explode: Mechanic<Params>['explode'] = (orderLine, params, ctx = {}) => {
  if (ctx.gift_already_granted) return [];
  let reached = false;
  if (params.threshold_qty != null) {
    reached = (ctx.order_total_qty ?? orderLine.qty) >= params.threshold_qty;
  } else if (params.threshold_eur != null) {
    const lineEur = orderLine.qty * (orderLine.unit_price_eur ?? 0);
    reached = (ctx.order_total_eur ?? lineEur) >= params.threshold_eur;
  }
  if (!reached) return [];
  return [{ item_id: params.gift_item, qty: roundQty(params.qty), line_type: 'free', parent_line_id: orderLine.id }];
};

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
