'use client';

import Link from 'next/link';
import { Suspense, useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { OfficeScreen } from '@dayson/domain';
import { t } from '@/i18n';
import { ScreenGuard } from '../ScreenGuard';
import { useUrlParam } from './hooks';
import { E, T } from './i18n';

export function Button({
  variant = 'dark', small, className = '', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'dark' | 'ghost' | 'danger'; small?: boolean }) {
  const tone = {
    primary: 'bg-brand text-paper hover:bg-brand-dark border-brand',
    dark: 'bg-ink text-paper hover:bg-ink-2 border-ink',
    ghost: 'bg-paper text-ink hover:bg-surface border-line-strong',
    danger: 'bg-paper text-brand hover:bg-brand-soft border-brand',
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        small ? 'min-h-8 px-2.5 text-xs' : 'min-h-10 px-4 text-sm'
      } ${tone} ${className}`}
    />
  );
}

const TONES: Record<string, string> = {
  ok: 'bg-ok-soft text-ok border-ok/30',
  warn: 'bg-warn-soft text-warn border-warn/30',
  bad: 'bg-brand-soft text-brand border-brand/30',
  dark: 'bg-ink text-paper border-ink',
  mute: 'bg-surface text-ink-soft border-line',
};

const VALUE_TONE: Record<string, keyof typeof TONES> = {
  available: 'ok', released: 'ok', green: 'ok', approved: 'ok', applied: 'ok', published: 'ok', done: 'ok', ok: 'ok',
  received: 'ok', dispatched: 'ok', shipped: 'ok', live: 'ok', accepted: 'ok', executed: 'ok', closed: 'mute', finished: 'ok',
  built: 'ok', high: 'ok', info: 'mute', arrived: 'ok', active: 'ok', actioned: 'ok',
  quarantine: 'warn', amber: 'warn', pending: 'warn', pending_approval: 'warn', held: 'warn', draft: 'mute', queued: 'warn',
  running: 'warn', warning: 'warn', recount: 'warn', simulated: 'warn', proposed: 'warn', edited: 'warn', medium: 'warn',
  partially_received: 'warn', in_progress: 'warn', in_transit: 'warn', timing: 'warn', planned: 'mute', open: 'warn',
  confirmed: 'dark', allocated: 'dark', picking: 'dark', loading: 'dark', ordered: 'dark',
  red: 'bad', blocked: 'bad', blocked_expiry: 'bad', rejected: 'bad', failed: 'bad', cancelled: 'bad', critical: 'bad',
  true_variance: 'bad', missing_doc: 'bad', mapping: 'warn', low: 'bad', scrapped: 'bad', damaged: 'bad', skipped: 'mute',
  superseded: 'mute', reviewed: 'mute', withdrawn: 'mute', dismissed: 'mute', empty: 'mute',
};

export function Badge({ children, tone = 'mute' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

/** Badge for a state / type / band value, translated and coloured by meaning. */
export function StatusBadge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted">—</span>;
  return <Badge tone={VALUE_TONE[String(value)] ?? 'mute'}>{E(value)}</Badge>;
}

export function Notice({ tone = 'bad', children }: { tone?: 'bad' | 'ok' | 'warn' | 'mute'; children: ReactNode }) {
  if (!children) return null;
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${TONES[tone]}`}>
      {children}
    </div>
  );
}

export function Loading() {
  return <p role="status" className="p-4 text-sm text-muted">{t('app.loading')}</p>;
}

export function Empty({ children }: { children?: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line-strong bg-surface p-5 text-center text-sm text-muted">{children ?? T('c.empty')}</p>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-paper ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h3 className="text-sm font-bold uppercase tracking-wide text-ink">{title}</h3>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A figure that opens the list behind it. */
export function Stat({ label, value, hint, href, onClick, tone }: {
  label: string; value: ReactNode; hint?: ReactNode; href?: string; onClick?: () => void; tone?: 'ok' | 'warn' | 'bad';
}) {
  const colour = tone === 'bad' ? 'text-brand' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink';
  const body = (
    <>
      <span className="block text-xs font-medium text-muted">{label}</span>
      <span className={`mt-1 block whitespace-nowrap text-xl font-bold tabular-nums ${colour}`}>{value}</span>
      {hint ? <span className="mt-0.5 block text-xs text-muted">{hint}</span> : null}
    </>
  );
  const cls = 'block rounded-md border border-line bg-paper p-3 text-left transition-colors hover:border-ink hover:bg-surface';
  if (href) return <Link href={href} className={cls} data-stat={label}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls} data-stat={label}>{body}</button>;
  return <div className="rounded-md border border-line bg-paper p-3">{body}</div>;
}

export function PageHeader({ title, desc, actions }: { title?: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {title ? <h2 className="text-lg font-bold">{title}</h2> : null}
        {desc ? <p className="text-sm text-muted">{desc}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export interface TabDef {
  id: string;
  label: string;
  render: () => ReactNode;
  hidden?: boolean;
}

/** Tabs kept in ?tab= so dashboard figures can link straight to a list. */
export function Tabs({ tabs }: { tabs: TabDef[] }) {
  const visible = tabs.filter((x) => !x.hidden);
  const [tab, setTab] = useUrlParam('tab', visible[0]?.id ?? '');
  const active = visible.find((x) => x.id === tab) ?? visible[0];
  return (
    <div>
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {visible.map((x) => (
          <button
            key={x.id}
            role="tab"
            type="button"
            aria-selected={x.id === active?.id}
            data-tab={x.id}
            onClick={() => setTab(x.id, { id: null, q: null })}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${
              x.id === active?.id ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{active?.render()}</div>
    </div>
  );
}

/** Section wrapper: role guard plus the Suspense boundary that useSearchParams needs. */
export function Section({ screen, children }: { screen: OfficeScreen; children: ReactNode }) {
  return (
    <ScreenGuard screen={`office.${screen}`}>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </ScreenGuard>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 p-4 md:p-10" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`w-full rounded-lg bg-paper shadow-xl ${wide ? 'max-w-4xl' : 'max-w-xl'}`}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-base font-bold">{title}</h3>
          <button type="button" onClick={onClose} aria-label={t('app.close')} className="rounded px-2 text-xl leading-none text-muted hover:text-ink">×</button>
        </header>
        <div className="space-y-3 p-5">{children}</div>
        {footer ? <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label={t('app.close')} className="flex-1 bg-ink/40" onClick={onClose} />
      <aside className={`flex h-full w-full flex-col bg-paper shadow-xl ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-base font-bold">{title}</h3>
          <button type="button" onClick={onClose} aria-label={t('app.close')} className="rounded px-2 text-xl leading-none text-muted hover:text-ink">×</button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}

export const inputCls =
  'min-h-10 w-full rounded-md border border-line-strong bg-paper px-3 text-sm text-ink placeholder:text-muted disabled:bg-surface';

export function Field({ label, error, hint, children, className = '' }: { label: string; error?: string | null; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-medium text-ink-soft">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs font-semibold text-brand">{error}</span> : null}
    </label>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function Select({ value, onChange, options, placeholder, disabled, name }: {
  value: string; onChange: (v: string) => void; options: readonly Option[]; placeholder?: string | null; disabled?: boolean; name?: string;
}) {
  return (
    <select name={name} className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== null ? <option value="">{placeholder ?? T('c.choose')}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Key / value list for a detail view. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="font-medium">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded-md bg-surface p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}
