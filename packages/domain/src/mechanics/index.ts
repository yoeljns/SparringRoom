/**
 * Mechanic registry. Adding a mechanic type = one new module here, its
 * Python twin in /worker/mechanics, its schema row in mechanic_type, tests.
 */
import * as buyXGetY from './buy_x_get_y';
import * as exportPush from './export_push';
import * as giftItem from './gift_item';
import * as launchSeed from './launch_seed';
import * as mixedSet from './mixed_set';
import * as priceDiscount from './price_discount';
import * as targetRebate from './target_rebate';
import * as volumeTier from './volume_tier';
import type { ExplodeContext, ExtraLine, Mechanic, OrderLineInput } from './types';

export * from './types';
export { itemRuleSchema, matchesItemRule, type ItemRule } from './item-rule';
export { buyXGetY, exportPush, giftItem, launchSeed, mixedSet, priceDiscount, targetRebate, volumeTier };

export const MECHANIC_CODES = [
  'price_discount',
  'volume_tier',
  'buy_x_get_y',
  'mixed_set',
  'gift_item',
  'target_rebate',
  'launch_seed',
  'export_push',
] as const;
export type MechanicCode = (typeof MECHANIC_CODES)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MECHANICS: Record<MechanicCode, Mechanic<any>> = {
  price_discount: priceDiscount.mechanic,
  volume_tier: volumeTier.mechanic,
  buy_x_get_y: buyXGetY.mechanic,
  mixed_set: mixedSet.mechanic,
  gift_item: giftItem.mechanic,
  target_rebate: targetRebate.mechanic,
  launch_seed: launchSeed.mechanic,
  export_push: exportPush.mechanic,
};

export function isMechanicCode(value: string): value is MechanicCode {
  return (MECHANIC_CODES as readonly string[]).includes(value);
}

export function getMechanic(mechanicCode: string): Mechanic<unknown> | null {
  return isMechanicCode(mechanicCode) ? MECHANICS[mechanicCode] : null;
}

/** Validate raw campaign params; returns a list of error messages (empty = valid). */
export function validateMechanicParams(mechanicCode: string, params: unknown): string[] {
  const mechanic = getMechanic(mechanicCode);
  if (!mechanic) return [`unknown mechanic: ${mechanicCode}`];
  const parsed = mechanic.paramsSchema.safeParse(params);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

/**
 * Validate params and explode one order line. Throws on an unknown mechanic
 * or invalid params so a bad campaign never silently adds nothing.
 */
export function explodeOrderLine(
  mechanicCode: string,
  orderLine: OrderLineInput,
  params: unknown,
  ctx: ExplodeContext = {},
): ExtraLine[] {
  const mechanic = getMechanic(mechanicCode);
  if (!mechanic) throw new Error(`unknown mechanic: ${mechanicCode}`);
  const parsed = mechanic.paramsSchema.parse(params);
  return mechanic.explode(orderLine, parsed, ctx);
}
