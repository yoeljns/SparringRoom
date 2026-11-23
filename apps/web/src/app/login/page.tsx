import type { Metadata } from 'next';
import { Brand } from '@/components/Brand';
import { t } from '@/i18n';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: t('auth.title') };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return (
    <main className="grid min-h-dvh md:grid-cols-[5fr_6fr]">
      <section className="relative flex flex-col justify-between overflow-hidden bg-ink p-8 text-paper md:p-12">
        <Brand label="Dayson" />
        <div className="py-10 md:py-0">
          <span className="block h-1.5 w-16 bg-brand" />
          <p className="mt-6 max-w-sm text-3xl font-extrabold leading-tight tracking-tight md:text-4xl">{t('app.name')}</p>
          <p className="mt-3 max-w-sm text-lg text-paper/70">{t('app.tagline')}</p>
        </div>
        <p className="hidden text-sm text-paper/40 md:block">Tuzla · İstanbul</p>
        <span aria-hidden="true" className="absolute -bottom-24 -right-24 hidden h-72 w-72 rounded-full border-[40px] border-brand md:block" />
      </section>
      <section className="flex items-center justify-center bg-paper p-6 md:p-12">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-extrabold tracking-tight">{t('auth.title')}</h1>
          <p className="mt-1 text-ink-soft">{t('auth.subtitle')}</p>
          <LoginForm next={params.next} configError={params.error === 'config'} />
        </div>
      </section>
    </main>
  );
}
