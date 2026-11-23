'use client';

import { useMemo, useState } from 'react';
import type { ClassifiedScan } from '@dayson/domain';
import { ScanInput } from '@/components/floor/ScanInput';
import { Icon } from '@/components/icons';
import { formatIsoDate, t } from '@/i18n';
import { createScanLogger } from '@/lib/data/scan-log';
import { feedback } from '@/lib/floor/feedback';
import { useOutbox } from '@/lib/floor/outbox/react';
import { KIND_LABEL, type ScanMeta } from '@/lib/floor/scan-flow';
import { useScanLogger } from '@/lib/floor/use-scan-logger';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-2">
      <dt className="text-sm font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-lg font-semibold">{value}</dd>
    </div>
  );
}

/**
 * Sorgu: scan anything to see what it is.
 * WIRING: the "where it is" part (pallet, lot and lane lookups) is added
 * when the RPC list arrives; today the screen shows what the code contains.
 */
export function QueryScreen() {
  const outbox = useOutbox();
  const logScan = useMemo(() => createScanLogger(outbox), [outbox]);
  const log = useScanLogger(logScan, 'query');
  const [scan, setScan] = useState<ClassifiedScan | null>(null);

  const onScan = (next: ClassifiedScan, meta: ScanMeta) => {
    setScan(next);
    if (next.kind === 'unknown') {
      feedback('refused');
      log(next, meta, 'unknown');
    } else {
      feedback('accepted');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ScanInput onScan={onScan} showLast={false} />
      {scan ? (
        scan.kind === 'unknown' ? (
          <div role="alert" className="flex items-center gap-3 rounded-xl bg-brand px-4 py-3 text-lg font-bold text-paper">
            <Icon name="x" size={28} className="shrink-0" />
            {t('scan.refused.unknown')}
          </div>
        ) : (
          <dl className="rounded-xl border-2 border-ink bg-paper px-4 pb-2 pt-3">
            <p className="pb-2 text-2xl font-extrabold">{t(KIND_LABEL[scan.kind])}</p>
            {scan.kind === 'location' ? <Row label={t('scan.field.code')} value={scan.code} /> : null}
            {scan.kind === 'pallet_serial' ? <Row label={t('scan.field.serial')} value={scan.serial} /> : null}
            {scan.kind === 'gs1' ? (
              <>
                {scan.data.sscc ? <Row label={t('scan.field.serial')} value={scan.data.sscc} /> : null}
                {scan.data.gtin ? <Row label={t('scan.field.gtin')} value={scan.data.gtin} /> : null}
                {scan.data.lot ? <Row label={t('scan.field.lot')} value={scan.data.lot} /> : null}
                {scan.data.expiry ? <Row label={t('scan.field.expiry')} value={formatIsoDate(scan.data.expiry)} /> : null}
                {scan.data.productionDate ? <Row label={t('scan.field.production')} value={formatIsoDate(scan.data.productionDate)} /> : null}
              </>
            ) : null}
            {(scan.kind === 'pallet_serial' && !scan.checkDigitValid) || (scan.kind === 'gs1' && scan.warnings.length > 0) ? (
              <p className="border-t border-line py-2 text-base font-semibold text-warn">{t('scan.checkDigitWarning')}</p>
            ) : null}
          </dl>
        )
      ) : (
        <p className="px-1 text-lg text-muted">{t('floor.desc.query')}</p>
      )}
    </div>
  );
}
