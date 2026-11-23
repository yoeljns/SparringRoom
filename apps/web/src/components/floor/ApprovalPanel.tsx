'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { t } from '@/i18n';
import { approvalById, requestApproval, type ApprovalRow } from '@/lib/data/floor-read';
import { errorText } from '@/lib/floor/errors';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { BigButton, Card, ChoiceGrid, type Choice } from './ui';

export interface ApprovalPanelProps {
  /** approval_request.type, e.g. "weight_override". */
  type: string;
  payload: Record<string, unknown>;
  title: string;
  body: string;
  reasons: readonly Choice[];
  /** Reads the current request (null when none was made yet). */
  find: (sb: SupabaseClient) => Promise<ApprovalRow | null>;
  /** Called with the new request id right after it was created. */
  onRequested?: (id: string) => void;
  /** Called whenever the known state changes. */
  onChange?: (row: ApprovalRow | null) => void;
}

/**
 * Second-person confirmation (weight override, over-receipt): the operator
 * picks a reason and sends the request; the panel then shows whether it is
 * pending, approved or rejected and re-checks every few seconds.
 */
export function ApprovalPanel({ type, payload, title, body, reasons, find, onRequested, onChange }: ApprovalPanelProps) {
  const [row, setRow] = useState<ApprovalRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const findRef = useRef(find);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    findRef.current = find;
    onChangeRef.current = onChange;
  }, [find, onChange]);

  /** Id of the request this panel follows, once it is known. */
  const idRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const sb = getBrowserSupabase();
      const next = idRef.current ? await approvalById(sb, idRef.current) : await findRef.current(sb);
      if (next) idRef.current = next.id;
      setRow(next);
      setLoaded(true);
      onChangeRef.current?.(next);
    } catch {
      // Offline: keep showing the last known state.
      setLoaded(true);
    }
  }, []);

  const state = row?.state ?? null;
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    // Keep checking while a decision is awaited.
    const id = state === 'pending' ? window.setInterval(() => void refresh(), 4000) : null;
    return () => {
      window.clearTimeout(first);
      if (id) window.clearInterval(id);
    };
  }, [refresh, state]);

  const send = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const id = await requestApproval(getBrowserSupabase(), type, payload, reason);
      idRef.current = id;
      onRequested?.(id);
      await refresh();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code ?? '') : '';
      const transient = err && typeof err === 'object' && 'transient' in err && (err as { transient: boolean }).transient;
      setError(transient ? t('floor.approval.needsNetwork') : errorText(code || undefined, err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const canRequest = loaded && (!row || state === 'rejected' || state === 'cancelled' || state === 'executed');

  return (
    <Card className="border-warn bg-warn-soft" testid="approval-panel">
      <p className="text-lg font-extrabold text-ink">{title}</p>
      <p className="mt-1 text-base text-ink-soft">{body}</p>

      {row ? (
        <p
          data-testid="approval-state"
          data-state={row.state}
          className={`mt-3 rounded-lg px-3 py-2 text-lg font-extrabold ${
            row.state === 'approved' ? 'bg-ok text-paper' : row.state === 'rejected' ? 'bg-brand text-paper' : 'bg-paper text-ink'
          }`}
        >
          {row.state === 'approved'
            ? t('floor.approval.approved')
            : row.state === 'rejected'
              ? t('floor.approval.rejected')
              : row.state === 'pending'
                ? t('floor.approval.pending')
                : t('floor.approval.closed')}
          {row.decision_note ? <span className="block text-sm font-semibold">{row.decision_note}</span> : null}
        </p>
      ) : null}

      {canRequest ? (
        <div className="mt-3 flex flex-col gap-3">
          <ChoiceGrid options={reasons} value={reason} onChange={setReason} label={t('floor.approval.reason')} testid="approval-reasons" />
          <BigButton onClick={() => void send()} disabled={!reason || busy} data-testid="approval-request">
            {busy ? t('floor.common.sending') : t('floor.approval.request')}
          </BigButton>
        </div>
      ) : state === 'pending' ? (
        <BigButton tone="ghost" className="mt-3" onClick={() => void refresh()} data-testid="approval-refresh">
          {t('floor.common.refresh')}
        </BigButton>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-base font-bold text-brand-dark">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
