import { t } from '@/i18n';

const NUMBER = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const KG = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

export function fmtQty(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : NUMBER.format(Number(value));
}

export function fmtKg(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : `${KG.format(Number(value))} kg`;
}

/** Quantity typed by the operator ("12", "12,5", "12.5"); null when it is not a number >= 0. */
export function parseQty(text: string): number | null {
  const cleaned = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const UOM_KEYS = { pallet: 'floor.uom.pallet', carton: 'floor.uom.carton', piece: 'floor.uom.piece' } as const;

export function uomLabel(uom: string | null | undefined): string {
  if (uom && uom in UOM_KEYS) return t(UOM_KEYS[uom as keyof typeof UOM_KEYS]);
  return uom ?? t('floor.uom.piece');
}

const DEVICE_KEY = 'dayson.device';

/** Stable id of this handheld, sent with every command and scan event. */
export function deviceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `tc-${crypto.randomUUID().slice(0, 8)}`;
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}
