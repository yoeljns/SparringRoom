import { z } from 'zod';
import type { Mechanic } from './types';

export const code = 'volume_tier';

export const paramsSchema = z.strictObject({
  tiers: z
    .array(z.strictObject({ min_qty: z.number().positive(), discount_pct: z.number().gt(0).lte(100) }))
    .min(1)
    .refine((tiers) => tiers.every((t, i) => i === 0 || t.min_qty > tiers[i - 1].min_qty), {
      message: 'tiers must be in ascending min_qty order without duplicates',
    }),
});
export type Params = z.infer<typeof paramsSchema>;

/** The tier a quantity falls in, or null below the first tier. */
export function tierFor(qty: number, params: Params): Params['tiers'][number] | null {
  let hit: Params['tiers'][number] | null = null;
  for (const tier of params.tiers) if (qty >= tier.min_qty) hit = tier;
  return hit;
}

/** No extra lines. */
export const explode: Mechanic<Params>['explode'] = () => [];

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
