/**
 * Campaign mechanic plugin interface, TypeScript side (spec section 9.2).
 * Each mechanic type is one Python module in /worker/mechanics plus this
 * mirror of `explode` for order entry. `explode` adds free and
 * bundle_component lines with quantities; it never changes the paid line.
 */
import type { z } from 'zod';

export type ExtraLineType = 'free' | 'bundle_component';

/** The order line being saved. Quantities are in the item's base unit. */
export interface OrderLineInput {
  id: string;
  item_id: string;
  qty: number;
  unit_price_eur?: number | null;
}

/** A line added by a mechanic. */
export interface ExtraLine {
  item_id: string;
  qty: number;
  line_type: ExtraLineType;
  parent_line_id: string;
}

/** Facts about the ordered item, used to evaluate an item rule. */
export interface ItemFacts {
  item_id: string;
  family_code?: string | null;
  attrs?: Record<string, unknown> | null;
}

export interface BundleLine {
  item_id: string;
  /** Component quantity per one bundle. */
  qty: number;
}

export interface ExplodeContext {
  /** Facts about orderLine.item_id; needed for family and attribute rules. */
  item?: ItemFacts;
  /** mixed_set: the bundle_line rows of params.bundle_id. */
  bundle_lines?: readonly BundleLine[];
  /** gift_item: order totals; default to the single line. */
  order_total_qty?: number;
  order_total_eur?: number;
  /** Free units this campaign already granted on other lines of the order. */
  free_qty_already_granted?: number;
  /** gift_item: true when this campaign already added its gift to the order. */
  gift_already_granted?: boolean;
}

export interface Mechanic<P> {
  code: string;
  paramsSchema: z.ZodType<P>;
  explode(orderLine: OrderLineInput, params: P, ctx?: ExplodeContext): ExtraLine[];
}

/** Round to the base-unit precision numeric(14,3). */
export function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}
