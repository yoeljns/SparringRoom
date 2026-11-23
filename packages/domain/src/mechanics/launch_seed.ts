import { z } from 'zod';
import type { Mechanic } from './types';

export const code = 'launch_seed';

export const paramsSchema = z.strictObject({
  item: z.string().min(1),
  /** Suggested seed quantity by dealer segment. */
  seed_qty: z
    .record(z.string().min(1), z.number().positive())
    .refine((t) => Object.keys(t).length > 0, { message: 'at least one segment quantity is required' }),
});
export type Params = z.infer<typeof paramsSchema>;

/**
 * No extra lines on an existing order line. The suggested order lines per
 * dealer are proposed by the worker, not added at order entry.
 */
export const explode: Mechanic<Params>['explode'] = () => [];

/** Suggested seed quantity for a dealer segment, or 0. */
export function seedQtyFor(segment: string, params: Params): number {
  return params.seed_qty[segment] ?? 0;
}

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
