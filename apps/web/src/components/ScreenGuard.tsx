'use client';

import type { ReactNode } from 'react';
import { canSee, type Screen } from '@dayson/domain';
import { t } from '@/i18n';
import { useProfile } from '@/lib/auth/profile-context';
import { Icon } from './icons';

function Notice({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-lg border border-line bg-paper p-6 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
        <Icon name="alert" />
      </div>
      <h2 className="text-lg font-bold">{title}</h2>
      {body ? <p className="mt-2 text-ink-soft">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Hides a screen the role may not see. The database refuses the data anyway
 * (RLS); this only avoids showing an empty or broken screen.
 */
export function ScreenGuard({ screen, children }: { screen: Screen; children: ReactNode }) {
  const { status, role, refresh, signOut } = useProfile();

  if (status === 'loading') {
    return (
      <p className="p-6 text-muted" role="status">
        {t('app.loading')}
      </p>
    );
  }
  const signOutButton = (
    <button type="button" onClick={() => void signOut()} className="min-h-12 rounded-md bg-ink px-5 font-semibold text-paper">
      {t('auth.signOut')}
    </button>
  );
  if (status === 'inactive') return <Notice title={t('auth.inactive')} action={signOutButton} />;
  if (status === 'missing' || status === 'signed_out') return <Notice title={t('auth.noProfile')} action={signOutButton} />;
  if (status === 'error') {
    return (
      <Notice
        title={t('auth.profileError')}
        action={
          <button type="button" onClick={refresh} className="min-h-12 rounded-md bg-ink px-5 font-semibold text-paper">
            {t('app.retry')}
          </button>
        }
      />
    );
  }
  if (!role || !canSee(role, screen)) {
    return <Notice title={t('auth.noAccessTitle')} body={t('auth.noAccessBody', { role: role ? t(`roles.${role}`) : '-' })} />;
  }
  return <>{children}</>;
}
