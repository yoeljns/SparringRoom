import { redirect } from 'next/navigation';
import { homePathFor } from '@dayson/domain';
import { getServerProfile } from '@/lib/data/server-profile';

export const dynamic = 'force-dynamic';

/** Send each role to its first screen. */
export default async function RootPage() {
  const result = await getServerProfile();
  if (result.status === 'ready') redirect(homePathFor(result.profile.role));
  if (result.status === 'signed_out') redirect('/login');
  // Signed in but without a usable profile: the dashboard guard explains why.
  redirect('/dashboard');
}
