'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { callRpc } from '@/lib/data/rpc';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { Outbox, webLock } from './engine';
import { createIdbOutboxStore } from './store';
import type { CallRpc, OutboxApi, OutboxState } from './types';

const SERVER_STATE: OutboxState = {
  queued: 0,
  rejected: 0,
  draining: false,
  online: true,
  lastError: null,
  needsAuth: false,
  nextRetryAt: null,
  ready: false,
};

const OutboxContext = createContext<Outbox | null>(null);

let singleton: Outbox | null = null;

/** One outbox per tab, sending through the browser Supabase client. */
function getOutbox(): Outbox {
  if (!singleton) {
    const send: CallRpc = (rpc, args) => callRpc(getBrowserSupabase(), rpc, args);
    singleton = new Outbox({ store: createIdbOutboxStore(), callRpc: send, withLock: webLock() });
  }
  return singleton;
}

export function OutboxProvider({ children, outbox }: { children: ReactNode; outbox?: Outbox }) {
  const instance = useMemo(() => outbox ?? (typeof window === 'undefined' ? null : getOutbox()), [outbox]);
  useEffect(() => {
    if (!instance) return;
    instance.start();
    // Safety net for a missed "online" event.
    const id = window.setInterval(() => {
      const s = instance.getState();
      if (s.queued > 0 && !s.draining && s.nextRetryAt === null) void instance.drain();
    }, 15_000);
    return () => {
      window.clearInterval(id);
      instance.stop();
    };
  }, [instance]);
  return <OutboxContext.Provider value={instance}>{children}</OutboxContext.Provider>;
}

const noopSubscribe = () => () => {};
const serverSnapshot = () => SERVER_STATE;

export type UseOutbox = OutboxState & OutboxApi & { outbox: Outbox | null };

/** Queue state (queued count, rejected count, online) plus the queue actions. */
export function useOutbox(): UseOutbox {
  const outbox = useContext(OutboxContext);
  const state = useSyncExternalStore(
    outbox ? outbox.subscribe : noopSubscribe,
    outbox ? outbox.getState : serverSnapshot,
    serverSnapshot,
  );
  return useMemo(() => {
    const missing = () => Promise.reject(new Error('useOutbox: no OutboxProvider'));
    return {
      ...state,
      outbox,
      enqueue: outbox ? outbox.enqueue.bind(outbox) : missing,
      submit: outbox ? outbox.submit.bind(outbox) : missing,
      drain: outbox ? outbox.drain.bind(outbox) : () => Promise.resolve(),
      listQueued: outbox ? outbox.listQueued.bind(outbox) : () => Promise.resolve([]),
      listRejected: outbox ? outbox.listRejected.bind(outbox) : () => Promise.resolve([]),
      acknowledgeRejected: outbox ? outbox.acknowledgeRejected.bind(outbox) : () => Promise.resolve(),
    };
  }, [state, outbox]);
}
