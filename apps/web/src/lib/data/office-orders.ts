/**
 * Order entry: applies live campaign mechanics to the keyed lines with the
 * TypeScript `explode` mirrors (spec 7.1 / 9.2) and builds the payload of
 * rpc_save_order. Pure functions; the screen loads the inputs.
 */
import { explodeOrderLine } from '@dayson/domain';
import type { Row } from './office-db';

export interface EntryLine {
  item_id: string;
  /** Quantity as keyed, in `uom`. */
  qty: number;
  uom: string;
  /** Lines read from a file may already be free goods. */
  line_type?: 'paid' | 'free';
}

export interface ItemInfo {
  id: string;
  sku: string;
  base_uom: string;
  family_code: string | null;
  attributes: Record<string, unknown> | null;
  /** uom level -> base units. */
  packs: Record<string, number>;
}

export interface BundleInfo {
  id: string;
  item_id: string;
  kind: string;
  lines: { item_id: string; qty: number }[];
}

/** One element of rpc_campaigns_for_order. */
export interface OrderCampaign {
  id: string;
  code: string;
  name: string;
  scopes: { item_rule: Row }[] | null;
  mechanics: { mechanic_type: string; params: Row; overridden?: boolean }[] | null;
  bundles: { bundle_id: string; item_id: string; kind: string; lines: { item_id: string; qty: number }[] | null }[] | null;
}

export interface SaveLine {
  ref: string;
  parent_ref?: string;
  item_id: string;
  qty: number;
  uom?: string;
  line_type: 'paid' | 'free' | 'bundle_component';
  bundle_id?: string;
  mechanic_code?: string;
  terms?: Row;
  /** Display only; removed before the call. */
  campaign_code?: string;
}

export interface BuiltOrder {
  lines: SaveLine[];
  campaign_id: string | null;
  warnings: string[];
}

/** Campaign scope item rule as the database reads it (app.rule_matches_item): any condition matches. */
export function scopeMatchesItem(rule: Row | null | undefined, item: ItemInfo): boolean {
  if (!rule || Object.keys(rule).length === 0 || rule.all === true) return true;
  if (Array.isArray(rule.item_ids) && rule.item_ids.includes(item.id)) return true;
  if (Array.isArray(rule.skus) && rule.skus.includes(item.sku)) return true;
  if (typeof rule.family === 'string' && rule.family === item.family_code) return true;
  if (rule.attributes && typeof rule.attributes === 'object') {
    const attrs = item.attributes ?? {};
    const want = Object.entries(rule.attributes as Row);
    if (want.length > 0 && want.every(([k, v]) => attrs[k] === v)) return true;
  }
  return false;
}

export function toBase(item: ItemInfo, qty: number, uom: string): number | null {
  if (!uom || uom === item.base_uom) return qty;
  const factor = item.packs[uom];
  return factor ? Math.round(qty * factor * 1000) / 1000 : null;
}

/**
 * Paid lines as keyed, plus the free and bundle_component lines their
 * campaigns add. A phantom bundle line always expands to its components.
 */
export function buildOrderLines(
  entry: readonly EntryLine[],
  items: ReadonlyMap<string, ItemInfo>,
  campaigns: readonly OrderCampaign[],
  bundles: readonly BundleInfo[],
): BuiltOrder {
  const lines: SaveLine[] = [];
  const warnings: string[] = [];
  let campaignId: string | null = null;

  const base = entry.map((l) => {
    const item = items.get(l.item_id);
    return { line: l, item, qtyBase: item ? toBase(item, l.qty, l.uom) : null };
  });
  const totalQty = base.reduce((s, b) => s + ((b.line.line_type ?? 'paid') === 'paid' ? (b.qtyBase ?? 0) : 0), 0);
  const granted = new Map<string, number>();
  const gifted = new Set<string>();

  base.forEach(({ line, item, qtyBase }, index) => {
    const ref = `L${index + 1}`;
    const type = line.line_type ?? 'paid';
    lines.push({ ref, item_id: line.item_id, qty: line.qty, uom: line.uom, line_type: type });
    if (!item || qtyBase === null) {
      warnings.push(`UOM_UNKNOWN:${item?.sku ?? line.item_id}:${line.uom}`);
      return;
    }
    if (type !== 'paid') return;
    const paid = lines[lines.length - 1];

    const phantom = bundles.find((b) => b.item_id === item.id && b.kind === 'phantom');
    if (phantom) {
      paid.bundle_id = phantom.id;
      phantom.lines.forEach((c, i) => {
        lines.push({ ref: `${ref}B${i + 1}`, parent_ref: ref, item_id: c.item_id, qty: Math.round(c.qty * qtyBase * 1000) / 1000, line_type: 'bundle_component', bundle_id: phantom.id });
      });
    }

    for (const c of campaigns) {
      const scopes = c.scopes ?? [];
      if (scopes.length > 0 && !scopes.some((s) => scopeMatchesItem(s.item_rule, item))) continue;
      let applied = false;
      (c.mechanics ?? []).forEach((m, mi) => {
        const key = `${c.id}:${mi}`;
        const bundle = m.mechanic_type === 'mixed_set' ? (c.bundles ?? []).find((b) => b.bundle_id === m.params?.bundle_id) : undefined;
        if (m.mechanic_type === 'mixed_set') {
          // The set mechanic belongs to the bundle item only; a phantom bundle is already expanded above.
          if (!bundle || bundle.item_id !== item.id) return;
          applied = true;
          paid.mechanic_code = m.mechanic_type;
          paid.campaign_code = c.code;
          if (phantom) return;
        }
        if (m.mechanic_type === 'price_discount' && typeof m.params?.discount_pct === 'number') {
          paid.terms = { ...(paid.terms ?? {}), campaign_code: c.code, discount_pct: m.params.discount_pct };
          paid.campaign_code = c.code;
          applied = true;
        }
        if (m.mechanic_type === 'volume_tier' && Array.isArray(m.params?.tiers)) {
          const tier = [...(m.params.tiers as Row[])].sort((a, b) => Number(b.min_qty) - Number(a.min_qty)).find((t) => qtyBase >= Number(t.min_qty));
          if (tier) {
            paid.terms = { ...(paid.terms ?? {}), campaign_code: c.code, discount_pct: tier.discount_pct, tier_min_qty: tier.min_qty };
            paid.campaign_code = c.code;
            applied = true;
          }
        }
        let extra;
        try {
          extra = explodeOrderLine(m.mechanic_type, { id: ref, item_id: item.id, qty: qtyBase }, m.params, {
            item: { item_id: item.id, family_code: item.family_code, attrs: item.attributes },
            bundle_lines: bundle?.lines ?? undefined,
            order_total_qty: totalQty,
            free_qty_already_granted: granted.get(key) ?? 0,
            gift_already_granted: gifted.has(key),
          });
        } catch (err) {
          warnings.push(`INVALID_PARAMS:${c.code}:${m.mechanic_type}:${err instanceof Error ? err.message.slice(0, 200) : ''}`);
          return;
        }
        extra.forEach((x, i) => {
          applied = true;
          lines.push({
            ref: `${ref}C${lines.length}${i}`, parent_ref: ref, item_id: x.item_id, qty: x.qty, line_type: x.line_type,
            mechanic_code: m.mechanic_type, campaign_code: c.code, ...(x.line_type === 'bundle_component' && bundle ? { bundle_id: bundle.bundle_id } : {}),
          });
          if (x.line_type === 'free') {
            granted.set(key, (granted.get(key) ?? 0) + x.qty);
            if (m.mechanic_type === 'gift_item') gifted.add(key);
          }
        });
      });
      if (applied && !campaignId) campaignId = c.id;
    }
  });
  return { lines, campaign_id: campaignId, warnings };
}

/** Lines for rpc_save_order (display-only keys removed). */
export function toSaveLines(lines: readonly SaveLine[]): Row[] {
  return lines.map(({ campaign_code: _c, ...rest }) => rest);
}

export interface ImportedOrder {
  doc_no: string;
  doc_date: string;
  logo_cari_code: string;
  party_id: string | null;
  lines: EntryLine[];
  hasFreeLines: boolean;
  errors: string[];
}

/**
 * Orders from a file in the Logo `sales_docs` column contract (there is no
 * separate order contract): one order per doc_no, doc_date is the requested
 * date, unit is matched to uom_pack.logo_unit, is_free marks a free line.
 */
export function ordersFromSalesDocs(
  rows: readonly Record<string, string>[],
  partyByCari: ReadonlyMap<string, string>,
  itemByLogoCode: ReadonlyMap<string, string>,
  uomByItemUnit: ReadonlyMap<string, string>,
): ImportedOrder[] {
  const out = new Map<string, ImportedOrder>();
  rows.forEach((r, i) => {
    let o = out.get(r.doc_no);
    if (!o) {
      o = { doc_no: r.doc_no, doc_date: r.doc_date, logo_cari_code: r.logo_cari_code, party_id: partyByCari.get(r.logo_cari_code) ?? null, lines: [], hasFreeLines: false, errors: [] };
      if (!o.party_id) o.errors.push(`UNKNOWN_PARTY:${r.logo_cari_code}`);
      out.set(r.doc_no, o);
    }
    const itemId = itemByLogoCode.get(r.logo_item_code);
    if (!itemId) {
      o.errors.push(`UNKNOWN_ITEM:${r.logo_item_code}`);
      return;
    }
    const uom = uomByItemUnit.get(`${itemId}|${r.unit}`);
    if (!uom) {
      o.errors.push(`UOM_UNKNOWN:${r.logo_item_code}:${r.unit}`);
      return;
    }
    const qty = Number(r.qty);
    if (!(qty > 0)) {
      o.errors.push(`INVALID:${i + 1}:qty`);
      return;
    }
    const free = r.is_free === 'true' || r.is_free === '1';
    if (free) o.hasFreeLines = true;
    o.lines.push({ item_id: itemId, qty, uom, line_type: free ? 'free' : 'paid' });
  });
  return [...out.values()];
}
