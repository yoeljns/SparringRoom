'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GS, classifyScan, type ClassifiedScan } from '@dayson/domain';
import { formatIsoDate, t, type MessageKey } from '@/i18n';
import { unlockAudio } from '@/lib/floor/feedback';
import { KIND_LABEL, type ScanMeta } from '@/lib/floor/scan-flow';
import { Icon } from '../icons';

export interface ManualReason {
  code: string;
  label: string;
}

/** Reason codes for manual entry; a manual entry counts against scan compliance. */
export const DEFAULT_MANUAL_REASONS: readonly { code: string; label: MessageKey }[] = [
  { code: 'label_damaged', label: 'scan.reasons.label_damaged' },
  { code: 'label_missing', label: 'scan.reasons.label_missing' },
  { code: 'scanner_fault', label: 'scan.reasons.scanner_fault' },
  { code: 'other', label: 'scan.reasons.other' },
];

export interface ScanInputProps {
  /** Called with the classified scan; the raw string is in scan.raw. */
  onScan: (scan: ClassifiedScan, meta: ScanMeta) => void;
  /** Ignore input while the previous scan is being processed. */
  disabled?: boolean;
  allowManual?: boolean;
  reasons?: readonly ManualReason[];
  /** Text shown in the scan field, e.g. what is expected next. */
  prompt?: string;
  showLast?: boolean;
}

function isOtherFormControl(el: Element | null, own: HTMLElement | null): boolean {
  if (!el || el === own) return false;
  if (el.closest('[data-scan-keep-focus]')) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** One-line description of a scan for the "last scan" row. */
export function describeScan(scan: ClassifiedScan): string {
  switch (scan.kind) {
    case 'location':
      return scan.code;
    case 'pallet_serial':
      return scan.serial;
    case 'gs1': {
      const parts: string[] = [];
      if (scan.data.sscc) parts.push(scan.data.sscc);
      if (scan.data.gtin) parts.push(`${t('scan.field.gtin')} ${scan.data.gtin}`);
      if (scan.data.lot) parts.push(`${t('scan.field.lot')} ${scan.data.lot}`);
      if (scan.data.expiry) parts.push(`${t('scan.field.expiry')} ${formatIsoDate(scan.data.expiry)}`);
      return parts.join(' · ');
    }
    case 'unknown':
      return scan.raw.replace(/[\x00-\x1f]/g, '␝').slice(0, 60);
  }
}

/**
 * Scan field for a Zebra TC22. DataWedge types the barcode as keystrokes and
 * ends with Enter (spec section 2, "Scanning"), so the input must always
 * hold the focus: it takes it back on blur, when the page becomes visible
 * and after a tap anywhere. The soft keyboard stays closed in scanner mode.
 *
 * Manual entry is a deliberate switch: the operator must pick a reason, and
 * the scan is reported with method "manual".
 */
export function ScanInput({
  onScan,
  disabled = false,
  allowManual = true,
  reasons,
  prompt,
  showLast = true,
}: ScanInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState(false);
  const [last, setLast] = useState<{ scan: ClassifiedScan; meta: ScanMeta } | null>(null);

  const reasonList: readonly ManualReason[] = reasons ?? DEFAULT_MANUAL_REASONS.map((r) => ({ code: r.code, label: t(r.label) }));

  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el || document.activeElement === el) return;
    if (isOtherFormControl(document.activeElement, el)) return;
    el.focus({ preventScroll: true });
  }, []);

  // Keep the focus: mount, tab visible again, window focus, tap anywhere.
  useEffect(() => {
    focusInput();
    const later = () => window.setTimeout(focusInput, 0);
    const onVisible = () => {
      if (document.visibilityState === 'visible') later();
    };
    const onPointer = () => {
      unlockAudio();
      later();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', later);
    document.addEventListener('pointerup', onPointer);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', later);
      document.removeEventListener('pointerup', onPointer);
    };
  }, [focusInput]);

  useEffect(() => {
    focusInput();
  }, [manual, disabled, focusInput]);

  const submit = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const raw = el.value;
    if (raw.trim().length === 0) {
      el.value = '';
      return;
    }
    if (disabled) {
      // Drop keystrokes that arrive while the previous scan is processed.
      el.value = '';
      return;
    }
    if (manual && !reason) {
      setReasonError(true);
      return;
    }
    el.value = '';
    const scan = classifyScan(raw);
    const meta: ScanMeta = manual ? { method: 'manual', reason_code: reason ?? undefined } : { method: 'scan' };
    setLast({ scan, meta });
    if (manual) {
      // Every manual entry is a fresh, deliberate choice.
      setManual(false);
      setReason(null);
      setReasonError(false);
    }
    onScan(scan, meta);
  }, [disabled, manual, reason, onScan]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    unlockAudio();
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    // Some DataWedge profiles send the GS1 separator (ASCII 29) as Ctrl+].
    if ((event.ctrlKey && event.key === ']') || event.key === GS) {
      event.preventDefault();
      const el = event.currentTarget;
      el.value += GS;
    }
  };

  const toggleManual = () => {
    setManual((m) => !m);
    setReason(null);
    setReasonError(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex items-stretch overflow-hidden rounded-xl border-2 bg-paper ${
          manual ? 'border-warn' : 'border-ink'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <span className={`flex w-14 shrink-0 items-center justify-center text-paper ${manual ? 'bg-warn' : 'bg-ink'}`}>
          <Icon name={manual ? 'keyboard' : 'barcode'} size={28} />
        </span>
        <input
          ref={inputRef}
          data-testid="scan-input"
          type="text"
          aria-label={manual ? t('scan.manualPlaceholder') : t('scan.placeholder')}
          placeholder={manual ? t('scan.manualPlaceholder') : (prompt ?? t('scan.placeholder'))}
          // "none" keeps the soft keyboard closed while the scanner types.
          inputMode={manual ? 'text' : 'none'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize={manual ? 'characters' : 'off'}
          spellCheck={false}
          enterKeyHint="send"
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(focusInput, 30)}
          className="h-16 min-w-0 flex-1 bg-transparent px-3 font-mono text-xl font-semibold text-ink outline-none placeholder:font-sans placeholder:text-base placeholder:font-medium placeholder:text-muted"
        />
        {manual ? (
          <button
            type="button"
            onClick={submit}
            className="min-w-24 shrink-0 bg-ink px-4 text-lg font-bold text-paper active:bg-ink-2"
          >
            {t('scan.submit')}
          </button>
        ) : null}
      </div>

      {manual ? (
        <div className="rounded-xl border border-warn bg-warn-soft p-3" data-testid="manual-panel">
          <p className="text-base font-bold text-ink">{t('scan.manualTitle')}</p>
          <p className="text-sm text-ink-soft">{t('scan.manualWarning')}</p>
          <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-ink-soft">{t('scan.reason')}</p>
          <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('scan.reason')}>
            {reasonList.map((r) => (
              <button
                key={r.code}
                type="button"
                role="radio"
                aria-checked={reason === r.code}
                onClick={() => {
                  setReason(r.code);
                  setReasonError(false);
                }}
                className={`min-h-14 rounded-lg border-2 px-2 text-base font-semibold ${
                  reason === r.code ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-paper text-ink'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reasonError ? (
            <p role="alert" className="mt-2 font-semibold text-brand">
              {t('scan.reasonRequired')}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        {showLast ? (
          <div className="min-w-0 flex-1 text-sm" data-testid="last-scan" aria-live="polite">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted">{t('scan.last')}</span>
            {last ? (
              <>
                <span className={`block text-base font-bold leading-tight ${last.scan.kind === 'unknown' ? 'text-brand' : 'text-ink'}`}>
                  {t(KIND_LABEL[last.scan.kind])}
                  {last.meta.method === 'manual' ? ` (${t('scan.method.manual')})` : ''}
                </span>
                <span className="block truncate font-mono text-sm text-ink-soft">{describeScan(last.scan)}</span>
              </>
            ) : (
              <span className="block text-base text-muted">{t('scan.none')}</span>
            )}
          </div>
        ) : (
          <span />
        )}
        {allowManual ? (
          <button
            type="button"
            onClick={toggleManual}
            aria-pressed={manual}
            className="flex min-h-12 shrink-0 items-center gap-2 rounded-lg border-2 border-line-strong bg-paper px-3 text-sm font-semibold text-ink active:bg-surface"
          >
            <Icon name={manual ? 'barcode' : 'keyboard'} size={20} />
            {manual ? t('scan.manualOff') : t('scan.manualOn')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
