import { z } from 'zod';
import type { Mechanic } from './types';

export const code = 'target_rebate';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date expected');

export const paramsSchema = z.strictObject({
  period: z
    .strictObject({ from: isoDate, to: isoDate })
    .refine((p) => p.from <= p.to, { message: 'period.from must not be after period.to' }),
  /** Target in EUR by dealer segment. */
  targets: z
    .record(z.string().min(1), z.number().positive())
    .refine((t) => Object.keys(t).length > 0, { message: 'at least one segment target is required' }),
  rebate_pct: z.number().gt(0).lte(100),
});
export type Params = z.infer<typeof paramsSchema>;

/** No lines; settle computes the rebate in the worker. */
export const explode: Mechanic<Params>['explode'] = () => [];

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
