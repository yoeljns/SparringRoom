import 'server-only';

import { DEV_NO_AUTH, isSupabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import { devProfile, fetchProfile, type ProfileResult } from './profile';

export async function getServerProfile(): Promise<ProfileResult> {
  if (DEV_NO_AUTH) return { status: 'ready', profile: devProfile() };
  if (!isSupabaseConfigured) return { status: 'signed_out' };
  return fetchProfile(await getServerSupabase());
}

/** The signed-in user id, or null. Used by route handlers. */
export async function getServerUserId(): Promise<string | null> {
  if (DEV_NO_AUTH) return devProfile().id;
  if (!isSupabaseConfigured) return null;
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  return error || !data.user ? null : data.user.id;
}
