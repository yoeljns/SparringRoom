import type { ReactNode } from 'react';
import { OfficeShell } from '@/components/office/OfficeShell';
import { ProfileProvider } from '@/lib/auth/profile-context';
import { getServerProfile } from '@/lib/data/server-profile';

export const dynamic = 'force-dynamic';

export default async function OfficeLayout({ children }: { children: ReactNode }) {
  const initial = await getServerProfile();
  return (
    <ProfileProvider initial={initial}>
      <OfficeShell>{children}</OfficeShell>
    </ProfileProvider>
  );
}
