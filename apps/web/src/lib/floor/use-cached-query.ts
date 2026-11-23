'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useProfile } from '@/lib/auth/profile-context';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { useOutbox } from './outbox/react';

export interface CachedQuery<T> {
  data: T | null;
  /** True until the first answer (from the cache or the server). */
  loading: boolean;
  /** True when `data` is the last cached list because the server could not be reached. */
  stale: boolean;
  /** When the shown data was read from the server (ISO). */
  fetchedAt: string | null;
  /** Message of a refused read (not a network failure). */
  error: string | null;
  reload: () => void;
}

interface CacheEntry<T> {
  at: string;
  data: T;
}

const PREFIX = 'dayson.floor.cache.';

function readCache<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as CacheEntry<T>) : null;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, entry: CacheEntry<T>): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // Storage full or unavailable: the list simply is not available offline.
  }
}

/**
 * Online-only read with an offline fallback: the last good answer is kept in
 * localStorage per user and shown, marked stale, while the server cannot be
 * reached. Reloads when the network returns and after `reload()`.
 * Pass key = null to skip the read.
 */
export function useCachedQuery<T>(key: string | null, fetcher: (sb: SupabaseClient) => Promise<T>): CachedQuery<T> {
  const { profile } = useProfile();
  const { online } = useOutbox();
  const userId = profile?.id ?? null;
  const cacheKey = key && userId ? `${userId}.${key}` : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; stale: boolean; fetchedAt: string | null; error: string | null }>({
    key: null,
    data: null,
    loading: true,
    stale: false,
    fetchedAt: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    if (!cacheKey) return;
    let cancelled = false;
    void (async () => {
      const cached = readCache<T>(cacheKey);
      if (!cancelled && cached) {
        // Show the cached list at once, but only if nothing fresher for this key is on screen.
        setState((s) => (s.key === cacheKey && s.data !== null ? s : { key: cacheKey, data: cached.data, loading: false, stale: !navigator.onLine, fetchedAt: cached.at, error: null }));
      }
      try {
        const data = await fetcherRef.current(getBrowserSupabase());
        if (cancelled) return;
        const at = new Date().toISOString();
        writeCache(cacheKey, { at, data });
        setState({ key: cacheKey, data, loading: false, stale: false, fetchedAt: at, error: null });
      } catch (err) {
        if (cancelled) return;
        const transient = !(err && typeof err === 'object' && 'transient' in err) || (err as { transient: boolean }).transient;
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({
          key: cacheKey,
          data: s.key === cacheKey ? s.data : (cached?.data ?? null),
          loading: false,
          stale: true,
          fetchedAt: s.key === cacheKey ? s.fetchedAt : (cached?.at ?? null),
          error: transient ? null : message,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, tick, online]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.key === cacheKey && cacheKey !== null;
  return {
    data: current ? state.data : null,
    loading: cacheKey !== null && (!current || state.loading),
    stale: current ? state.stale : false,
    fetchedAt: current ? state.fetchedAt : null,
    error: current ? state.error : null,
    reload,
  };
}
