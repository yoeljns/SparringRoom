/**
 * GS1 element string builders for labels (spec section 6, "Encoding rules").
 * Fixed-length identifiers first, lot last, so no separator is needed.
 * The returned string carries no FNC1; the label template adds it.
 */
import { formatGs1Date, hasValidGs1CheckDigit } from './scan';

const LOT_RE = /^[!"%-?A-Z_a-z]{1,20}$/;

function assertDigits(name: string, value: string, length: number): void {
  if (!new RegExp(`^\\d{${length}}$`).test(value)) {
    throw new Error(`${name} must be exactly ${length} digits`);
  }
}

function assertLot(lot: string): void {
  if (!LOT_RE.test(lot)) throw new Error('lot must be 1-20 characters of the GS1 character set 82');
}

/** Left-pad a GTIN-8/12/13 to 14 digits and verify its check digit. */
export function normalizeGtin14(gtin: string): string {
  if (!/^(\d{8}|\d{12,14})$/.test(gtin)) throw new Error('GTIN must be 8, 12, 13 or 14 digits');
  const g = gtin.padStart(14, '0');
  if (!hasValidGs1CheckDigit(g)) throw new Error('GTIN check digit is wrong');
  return g;
}

export interface PalletGs1Input {
  /** 18-digit SSCC or internal pallet serial. */
  sscc: string;
  gtin: string;
  /** ISO date. */
  expiry: string;
  /** ISO date. */
  productionDate: string;
  lot: string;
}

/** Pallet label: (00)(01)(17)(11)(10). */
export function encodePalletGs1(input: PalletGs1Input): string {
  assertDigits('sscc', input.sscc, 18);
  assertLot(input.lot);
  return (
    '00' + input.sscc +
    '01' + normalizeGtin14(input.gtin) +
    '17' + formatGs1Date(input.expiry) +
    '11' + formatGs1Date(input.productionDate) +
    '10' + input.lot
  );
}

export interface CartonGs1Input {
  gtin: string;
  /** ISO date. */
  expiry: string;
  lot: string;
}

/** Carton label: (01)(17)(10). */
export function encodeCartonGs1(input: CartonGs1Input): string {
  assertLot(input.lot);
  return '01' + normalizeGtin14(input.gtin) + '17' + formatGs1Date(input.expiry) + '10' + input.lot;
}

/** Human-readable interpretation, e.g. "(00)123...(10)LOT1". */
export function gs1HumanReadable(elementString: string): string {
  let out = '';
  let i = 0;
  const lengths: Record<string, number> = { '00': 18, '01': 14, '17': 6, '11': 6 };
  while (i < elementString.length) {
    const ai = elementString.slice(i, i + 2);
    const len = lengths[ai];
    if (len) {
      out += `(${ai})${elementString.slice(i + 2, i + 2 + len)}`;
      i += 2 + len;
    } else {
      out += `(${ai})${elementString.slice(i + 2)}`;
      break;
    }
  }
  return out;
}
