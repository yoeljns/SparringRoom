import { z } from 'zod';
import { roundQty, type Mechanic } from './types';

export const code = 'mixed_set';

export const paramsSchema = z.strictObject({
  bundle_id: z.string().min(1),
  /** Set price in EUR, booked in Logo. */
  price: z.number().nonnegative(),
});
export type Params = z.infer<typeof paramsSchema>;

/**
 * Phantom bundle (section 9.3): the bundle order line explodes into its
 * component lines; the bundle SKU itself is never stocked. The caller loads
 * the bundle_line rows of params.bundle_id into ctx.bundle_lines.
 */
export const explode: Mechanic<Params>['explode'] = (orderLine, _params, ctx = {}) => {
  const components = ctx.bundle_lines ?? [];
  return components
    .filter((c) => c.qty > 0)
    .map((c) => ({
      item_id: c.item_id,
      qty: roundQty(c.qty * orderLine.qty),
      line_type: 'bundle_component' as const,
      parent_line_id: orderLine.id,
    }));
};

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
