import { z } from 'zod';
import type { ItemFacts } from './types';

/**
 * Which items a rule covers. All given conditions must hold.
 *   { item_ids: [...] }                       named items
 *   { family_code: 'PU' }                     a whole family
 *   { family_code: 'PU', attrs: { volume_ml: 600 } }  family plus attributes
 */
export const itemRuleSchema = z
  .strictObject({
    item_ids: z.array(z.string().min(1)).min(1).optional(),
    family_code: z.string().min(1).optional(),
    attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .refine((r) => r.item_ids !== undefined || r.family_code !== undefined || r.attrs !== undefined, {
    message: 'item rule needs item_ids, family_code or attrs',
  });

export type ItemRule = z.infer<typeof itemRuleSchema>;

export function matchesItemRule(rule: ItemRule, itemId: string, facts?: ItemFacts): boolean {
  if (rule.item_ids && !rule.item_ids.includes(itemId)) return false;
  if (rule.family_code !== undefined && facts?.family_code !== rule.family_code) return false;
  if (rule.attrs) {
    for (const [key, value] of Object.entries(rule.attrs)) {
      if (facts?.attrs?.[key] !== value) return false;
    }
  }
  return true;
}
