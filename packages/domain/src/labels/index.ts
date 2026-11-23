/**
 * Label rendering (spec section 6). Templates live in /labels/*.zpl and are
 * copied into templates.generated.ts by `pnpm --filter domain gen`.
 */
import { z } from 'zod';
import { encodeCartonGs1, encodePalletGs1, gs1HumanReadable } from '../gs1-encode';
import { LOCATION_CODE_RE } from '../scan';
import { LABEL_TEMPLATES } from './templates.generated';

export { LABEL_TEMPLATES };
export type LabelTemplateName = keyof typeof LABEL_TEMPLATES;
export const LABEL_TEMPLATE_NAMES = Object.keys(LABEL_TEMPLATES) as LabelTemplateName[];

/** Escape a value for a ZPL field that is preceded by ^FH\ (backslash = hex indicator). */
export function escapeZplField(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '^' || ch === '~' || cp < 0x20 || cp === 0x7f) {
      out += '\\' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

const TOKEN_RE = /\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g;

/** Token names used by a template. */
export function labelTokens(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

/**
 * Fill {{token}} placeholders. Values are escaped for ^FH\ fields;
 * {{token|bx}} also doubles "_" for DataMatrix (^BX) field data.
 * `copies` defaults to 1. Throws when a token has no value.
 */
export function renderLabel(template: string, data: Record<string, string | number>): string {
  const values: Record<string, string | number> = { copies: 1, ...data };
  const missing: string[] = [];
  const out = template.replace(TOKEN_RE, (_m, name: string, filter?: string) => {
    const raw = values[name];
    if (raw === undefined || raw === null) {
      missing.push(name);
      return '';
    }
    let value = String(raw);
    if (filter === 'bx') value = value.replace(/_/g, '__');
    else if (filter) throw new Error(`renderLabel: unknown filter ${filter}`);
    return escapeZplField(value);
  });
  if (missing.length > 0) throw new Error(`renderLabel: missing values: ${[...new Set(missing)].join(', ')}`);
  return out;
}

/** ISO date to DD.MM.YYYY. */
export function formatDateTr(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`formatDateTr: not an ISO date: ${isoDate}`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Kilograms with a Turkish decimal comma, at most 3 decimals. */
export function formatKgTr(kg: number): string {
  return (Math.round(kg * 1000) / 1000).toString().replace('.', ',');
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date expected');
const copies = z.number().int().min(1).max(50);

export const palletLabelSchema = z.strictObject({
  sscc: z.string().regex(/^\d{18}$/),
  gtin: z.string().regex(/^(\d{8}|\d{12,14})$/),
  sku: z.string().min(1).max(40),
  description: z.string().min(1).max(120),
  lot: z.string().min(1).max(20),
  expiry: isoDate,
  production_date: isoDate,
  pallet_kg: z.number().positive().max(2000),
});
export type PalletLabelInput = z.infer<typeof palletLabelSchema>;

export const locationLabelSchema = z.strictObject({
  code: z.string().regex(LOCATION_CODE_RE).max(16),
});
export type LocationLabelInput = z.infer<typeof locationLabelSchema>;

export const cartonLabelSchema = z.strictObject({
  gtin: z.string().regex(/^(\d{8}|\d{12,14})$/),
  sku: z.string().min(1).max(40),
  lot: z.string().min(1).max(20),
  expiry: isoDate,
});
export type CartonLabelInput = z.infer<typeof cartonLabelSchema>;

export const labelRequestSchema = z.discriminatedUnion('template', [
  z.strictObject({ template: z.literal('pallet'), data: palletLabelSchema, copies: copies.default(1) }),
  z.strictObject({ template: z.literal('location'), data: locationLabelSchema, copies: copies.default(1) }),
  z.strictObject({ template: z.literal('carton'), data: cartonLabelSchema, copies: copies.default(1) }),
]);
export type LabelRequest = z.infer<typeof labelRequestSchema>;

export function palletLabelFields(input: PalletLabelInput): Record<string, string> {
  const gs1 = encodePalletGs1({
    sscc: input.sscc,
    gtin: input.gtin,
    expiry: input.expiry,
    productionDate: input.production_date,
    lot: input.lot,
  });
  return {
    sku: input.sku,
    description: input.description,
    lot: input.lot,
    expiry_tr: formatDateTr(input.expiry),
    production_tr: formatDateTr(input.production_date),
    pallet_kg: formatKgTr(input.pallet_kg),
    gs1,
    gs1_hri: gs1HumanReadable(gs1),
    serial: input.sscc,
  };
}

/** Code 128 subset B width in dots for the location barcode (module width 5). */
function code128Dots(chars: number, moduleDots: number): number {
  return ((chars + 3) * 11 + 2) * moduleDots;
}

export function locationLabelFields(input: LocationLabelInput): Record<string, string | number> {
  // Centre the rotated barcode along the 1200-dot label length.
  const barcodeY = Math.max(20, Math.round((1200 - code128Dots(input.code.length, 5)) / 2));
  return { code: input.code, barcode_y: barcodeY };
}

export function cartonLabelFields(input: CartonLabelInput): Record<string, string> {
  const gs1 = encodeCartonGs1({ gtin: input.gtin, expiry: input.expiry, lot: input.lot });
  return {
    sku: input.sku,
    lot: input.lot,
    expiry_tr: formatDateTr(input.expiry),
    gs1,
    gs1_hri: gs1HumanReadable(gs1),
  };
}

/** Validate a label request and render its ZPL. Throws a ZodError on bad input. */
export function renderLabelRequest(request: unknown): { zpl: string; request: LabelRequest } {
  const parsed = labelRequestSchema.parse(request);
  let fields: Record<string, string | number>;
  switch (parsed.template) {
    case 'pallet':
      fields = palletLabelFields(parsed.data);
      break;
    case 'location':
      fields = locationLabelFields(parsed.data);
      break;
    case 'carton':
      fields = cartonLabelFields(parsed.data);
      break;
  }
  const zpl = renderLabel(LABEL_TEMPLATES[parsed.template], { ...fields, copies: parsed.copies });
  return { zpl, request: parsed };
}
