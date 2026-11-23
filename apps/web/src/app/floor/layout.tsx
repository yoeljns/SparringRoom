import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { FloorShell } from '@/components/floor/FloorShell';
import { ServiceWorkerRegister } from '@/components/floor/ServiceWorkerRegister';
import { t } from '@/i18n';
import { ProfileProvider } from '@/lib/auth/profile-context';
import { OutboxProvider } from '@/lib/floor/outbox/react';

export const metadata: Metadata = {
  title: { default: t('app.floorName'), template: `%s · ${t('app.floorName')}` },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: t('app.floorName'), statusBarStyle: 'black' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b0b0c',
};

/**
 * Floor app (PWA on Zebra TC22). The pages are static so the service worker
 * can cache the shell; the profile and the outbox load in the browser.
 */
export default function FloorLayout({ children }: { children: ReactNode }) {
  return (
    <ProfileProvider>
      <OutboxProvider>
        <ServiceWorkerRegister />
        <FloorShell>{children}</FloorShell>
      </OutboxProvider>
    </ProfileProvider>
  );
}
