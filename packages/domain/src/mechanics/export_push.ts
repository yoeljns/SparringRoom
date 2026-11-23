import { z } from 'zod';
import type { Mechanic } from './types';

export const code = 'export_push';

export const paramsSchema = z.strictObject({
  market: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
  /** Commercial terms, free text or a structured object agreed with sales. */
  terms: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
});
export type Params = z.infer<typeof paramsSchema>;

/** No extra lines. */
export const explode: Mechanic<Params>['explode'] = () => [];

export const mechanic: Mechanic<Params> = { code, paramsSchema, explode };
