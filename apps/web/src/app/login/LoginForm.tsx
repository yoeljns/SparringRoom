'use client';

import { useState, type FormEvent } from 'react';
import { t } from '@/i18n';
import { DEV_NO_AUTH, isSupabaseConfigured } from '@/lib/env';
import { getBrowserSupabase } from '@/lib/supabase/browser';

function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.startsWith('/login')) return '/';
  return value;
}

export function LoginForm({ next, configError }: { next?: string; configError?: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const notConfigured = !isSupabaseConfigured && !DEV_NO_AUTH;
  const [error, setError] = useState<string | null>(configError || notConfigured ? t('auth.notConfigured') : null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (DEV_NO_AUTH) {
      window.location.assign(safeNext(next));
      return;
    }
    if (notConfigured) {
      setError(t('auth.notConfigured'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: signInError } = await getBrowserSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) {
        // status 400 = wrong credentials; anything else is the network or the server.
        setError(signInError.status === 400 ? t('auth.invalidCredentials') : t('auth.networkError'));
        setPending(false);
        return;
      }
      // Full navigation so the proxy and server components see the new session cookie.
      window.location.assign(safeNext(next));
    } catch {
      setError(t('auth.networkError'));
      setPending(false);
    }
  }

  const fieldClass =
    'mt-1 block h-12 w-full rounded-md border border-line-strong bg-paper px-3 text-base text-ink outline-none focus:border-ink focus:ring-2 focus:ring-ink/10';

  return (
    <form onSubmit={onSubmit} method="post" action="/login" className="mt-8 flex flex-col gap-5" noValidate={false}>
      <label className="block text-sm font-semibold text-ink">
        {t('auth.email')}
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="block text-sm font-semibold text-ink">
        {t('auth.password')}
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={fieldClass}
        />
      </label>
      {error ? (
        <p role="alert" className="rounded-md border border-brand bg-brand-soft px-3 py-2 text-sm font-semibold text-brand-dark">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-md bg-brand text-base font-bold text-paper transition-colors hover:bg-brand-dark disabled:opacity-60"
      >
        {pending ? t('auth.signingIn') : t('auth.signIn')}
      </button>
      {DEV_NO_AUTH ? <p className="text-center text-xs font-semibold text-muted">{t('auth.devMode')}</p> : null}
    </form>
  );
}
