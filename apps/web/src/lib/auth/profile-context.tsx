'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Role } from '@dayson/domain';
import { devProfile, fetchProfile, toProfile, type Profile, type ProfileResult } from '@/lib/data/profile';
import { DEV_NO_AUTH, isSupabaseConfigured } from '@/lib/env';
import { getBrowserSupabase } from '@/lib/supabase/browser';

export type ProfileStatus = 'loading' | ProfileResult['status'];

export interface ProfileState {
  status: ProfileStatus;
  profile: Profile | null;
  role: Role | null;
  /** True when the profile comes from the offline cache. */
  stale: boolean;
  refresh: () => void;
  signOut: () => Promise<void>;
}

const CACHE_KEY = 'dayson.profile';

function readCache(): Profile | null {
  try {
    return toProfile(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function writeCache(profile: Profile | null): void {
  try {
    if (profile) window.localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
    else window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage may be unavailable; the profile is then fetched every time.
  }
}

const ProfileContext = createContext<ProfileState | null>(null);

interface InternalState {
  result: ProfileResult | null;
  stale: boolean;
}

/**
 * Loads the signed-in user's app_user row. `initial` comes from the server
 * layout when available; the floor app also keeps a cached copy so it can
 * start without network.
 */
export function ProfileProvider({ children, initial }: { children: ReactNode; initial?: ProfileResult }) {
  const [state, setState] = useState<InternalState>(() => ({
    result: DEV_NO_AUTH ? { status: 'ready', profile: devProfile() } : (initial ?? null),
    stale: false,
  }));
  const [tick, setTick] = useState(0);
  const hasInitial = initial !== undefined;

  useEffect(() => {
    if (DEV_NO_AUTH) return;
    if (hasInitial && tick === 0) {
      if (initial?.status === 'ready') writeCache(initial.profile);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!isSupabaseConfigured) {
        if (!cancelled) setState({ result: { status: 'signed_out' }, stale: false });
        return;
      }
      const result = await fetchProfile(getBrowserSupabase(), { localSession: true });
      if (cancelled) return;
      if (result.status === 'ready') {
        writeCache(result.profile);
        setState({ result, stale: false });
      } else if (result.status === 'error') {
        // Offline start: fall back to the last known profile.
        const cached = readCache();
        setState(cached?.active ? { result: { status: 'ready', profile: cached }, stale: true } : { result, stale: false });
      } else {
        writeCache(null);
        setState({ result, stale: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is read once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, hasInitial]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // A profile taken from the offline cache is re-read when the network returns.
  const stale = state.stale;
  useEffect(() => {
    if (!stale) return;
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [stale, refresh]);

  const signOut = useCallback(async () => {
    writeCache(null);
    if (!DEV_NO_AUTH && isSupabaseConfigured) {
      await getBrowserSupabase().auth.signOut().catch(() => {});
    }
    // Full page load on purpose: it drops all client state of the signed-out user.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/login');
  }, []);

  const value = useMemo<ProfileState>(() => {
    const result = state.result;
    const profile = result && 'profile' in result ? result.profile : null;
    return {
      status: result ? result.status : 'loading',
      profile,
      role: result?.status === 'ready' ? result.profile.role : null,
      stale: state.stale,
      refresh,
      signOut,
    };
  }, [state, refresh, signOut]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/** The signed-in user's row from app_user (id, full_name, role, active). */
export function useProfile(): ProfileState {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used inside <ProfileProvider>');
  return ctx;
}
