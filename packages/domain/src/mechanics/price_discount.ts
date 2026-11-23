import { z } from 'zod';
import type { Mechanic } from './types';

export const code = 'price_discount';

export const paramsSchema = z.strictObject({
  discount_pct: z.number().gt(0).lte(100),
});
export type Params = z.infer<typeof paramsSchema>;

/** No extra lines: the discount is a commercial term booked in Logo. */
export const explode: Mechanic<Params>['explode'] = () => [];

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
