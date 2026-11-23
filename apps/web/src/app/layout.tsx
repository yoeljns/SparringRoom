import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: { default: t('app.name'), template: `%s · ${t('app.name')}` },
  description: t('app.tagline'),
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon-192.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#d6001c',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
