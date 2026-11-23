'use client';

import { useMemo, useState } from 'react';
import { ScanFlow } from '@/components/floor/ScanFlow';
import { t } from '@/i18n';
import { createScanLogger } from '@/lib/data/scan-log';
import { useOutbox } from '@/lib/floor/outbox/react';

/**
 * WIRING: this screen runs the three-scan flow without posting anything, so
 * scanner settings can be tried on the device. The transfer transaction
 * (pallet lookup, post_txn) is added when the RPC list arrives.
 */
export function TransferTrial() {
  const outbox = useOutbox();
  const logScan = useMemo(() => createScanLogger(outbox), [outbox]);
  const [done, setDone] = useState(false);
  const [round, setRound] = useState(0);

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg bg-warn-soft px-3 py-2 text-base font-semibold text-warn">{t('floor.testMode')}</p>
      <ScanFlow key={round} context="transfer" logScan={logScan} onComplete={() => setDone(true)} />
      {done ? (
        <div className="rounded-xl border-2 border-line bg-paper p-4">
          <p className="text-lg font-semibold">{t('floor.testDone')}</p>
          <button
            type="button"
            onClick={() => {
              setDone(false);
              setRound((n) => n + 1);
            }}
            className="mt-3 min-h-14 w-full rounded-xl bg-ink text-lg font-bold text-paper"
          >
            {t('flow.restart')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
