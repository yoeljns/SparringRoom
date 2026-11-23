'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { errText } from './i18n';

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs an async loader when `deps` change; keeps the last data while reloading. */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const key = JSON.stringify(deps);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error: string | null }>({ key: '', error: null });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  useEffect(() => {
    let cancelled = false;
    const runKey = `${key}#${tick}`;
    loaderRef.current().then(
      (data) => {
        if (!cancelled) setState({ key: runKey, data, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState((s) => ({ key: runKey, data: s.data, error: errText(err) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.key === `${key}#${tick}`;
  // Data of another key is never shown; data of the same key stays visible during a reload.
  const sameKey = state.key.startsWith(`${key}#`);
  return { data: sameKey ? state.data : undefined, error: current ? state.error : null, loading: !current, reload };
}

/** One URL search parameter as state (tabs, filters that the dashboard links to). */
export function useUrlParam(name: string, fallback = ''): [string, (value: string, extra?: Record<string, string | null>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name) ?? fallback;
  const set = useCallback(
    (next: string, extra?: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      if (next) sp.set(name, next);
      else sp.delete(name);
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (v === null || v === '') sp.delete(k);
        else sp.set(k, v);
      }
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, router, pathname, name],
  );
  return [value, set];
}

/** Runs a write and reports busy / error / done. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
