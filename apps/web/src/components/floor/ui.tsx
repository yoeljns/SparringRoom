'use client';

import { Suspense, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Screen } from '@dayson/domain';
import { formatDateTime, t } from '@/i18n';
import { Icon, type IconName } from '../icons';
import { ScreenGuard } from '../ScreenGuard';

/** Role guard plus the Suspense boundary that useSearchParams needs on a static page. */
export function FloorPage({ screen, children }: { screen: Screen; children: ReactNode }) {
  return (
    <ScreenGuard screen={screen}>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </ScreenGuard>
  );
}

export function Loading() {
  return (
    <p role="status" className="p-4 text-lg text-muted">
      {t('app.loading')}
    </p>
  );
}

export type Tone = 'ok' | 'bad' | 'warn' | 'info';

const BANNER: Record<Tone, { box: string; icon: IconName }> = {
  ok: { box: 'bg-ok-soft text-ok', icon: 'check' },
  bad: { box: 'bg-brand text-paper', icon: 'x' },
  warn: { box: 'bg-warn-soft text-warn', icon: 'alert' },
  info: { box: 'bg-surface text-ink border border-line-strong', icon: 'alert' },
};

export function Banner({ tone, children, testid, shakeKey }: { tone: Tone; children: ReactNode; testid?: string; shakeKey?: number }) {
  const style = BANNER[tone];
  return (
    <div
      key={shakeKey}
      role={tone === 'bad' ? 'alert' : 'status'}
      data-testid={testid ?? `banner-${tone}`}
      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-lg font-bold ${style.box} ${tone === 'bad' ? 'animate-refused' : ''}`}
    >
      <Icon name={style.icon} size={26} className="shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

export interface Notice {
  tone: Tone;
  text: string;
  /** Changes on every new notice so the refusal animation restarts. */
  n: number;
}

let noticeSeq = 0;
export function notice(tone: Tone, text: string): Notice {
  noticeSeq += 1;
  return { tone, text, n: noticeSeq };
}

export function NoticeBanner({ value, testid }: { value: Notice | null; testid?: string }) {
  if (!value) return null;
  return (
    <Banner tone={value.tone} shakeKey={value.n} testid={testid ?? 'notice'}>
      {value.text}
    </Banner>
  );
}

type ButtonTone = 'primary' | 'ghost' | 'danger' | 'ok';
const BUTTON: Record<ButtonTone, string> = {
  primary: 'bg-ink text-paper active:bg-ink-2',
  ghost: 'border-2 border-line-strong bg-paper text-ink active:bg-surface',
  danger: 'bg-brand text-paper active:bg-brand-dark',
  ok: 'bg-ok text-paper',
};

/** Glove-sized button: at least 56 px high. */
export function BigButton({
  tone = 'primary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 text-lg font-bold disabled:opacity-40 ${BUTTON[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '', testid }: { children: ReactNode; className?: string; testid?: string }) {
  return (
    <section data-testid={testid} className={`rounded-xl border-2 border-line bg-paper p-3 ${className}`}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="flex items-baseline justify-between gap-2 px-1 text-sm font-extrabold uppercase tracking-wide text-ink-soft">
      <span>{children}</span>
      {count !== undefined ? <span className="tabular-nums text-muted">{count}</span> : null}
    </h2>
  );
}

/** Label / value line of a detail card. */
export function Row({ label, value, mono = false, testid }: { label: string; value: ReactNode; mono?: boolean; testid?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <dt className="shrink-0 text-sm font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd data-testid={testid} className={`min-w-0 break-words text-right text-lg font-semibold ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

export interface Choice<T extends string = string> {
  value: T;
  label: string;
}

/** Large radio buttons: reason codes, units, decisions. No typing. */
export function ChoiceGrid<T extends string>({
  options,
  value,
  onChange,
  label,
  columns = 2,
  testid,
}: {
  options: readonly Choice<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  columns?: 2 | 3;
  testid?: string;
}) {
  return (
    <div>
      <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <div role="radiogroup" aria-label={label} data-testid={testid} className={`grid gap-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            data-value={o.value}
            onClick={() => onChange(o.value)}
            className={`min-h-14 rounded-lg border-2 px-2 text-base font-semibold leading-tight ${
              value === o.value ? 'border-ink bg-ink text-paper' : 'border-line-strong bg-paper text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Text field for the few things that are typed: quantities, kg, lot numbers, document numbers. */
export function TextField({
  label,
  value,
  onChange,
  testid,
  numeric = false,
  type = 'text',
  suffix,
  invalid = false,
  placeholder,
  uppercase = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testid?: string;
  numeric?: boolean;
  type?: 'text' | 'date';
  suffix?: string;
  invalid?: boolean;
  placeholder?: string;
  uppercase?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold uppercase tracking-wide text-ink-soft">{label}</span>
      <span className={`flex items-stretch overflow-hidden rounded-xl border-2 bg-paper ${invalid ? 'border-brand' : 'border-line-strong focus-within:border-ink'}`}>
        <input
          data-testid={testid}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(uppercase ? e.target.value.toUpperCase() : e.target.value)}
          inputMode={numeric ? 'decimal' : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize={uppercase ? 'characters' : 'off'}
          spellCheck={false}
          enterKeyHint="done"
          onKeyDown={(e) => {
            // Enter closes the keyboard; it must not reach a scan handler.
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="h-14 min-w-0 flex-1 bg-transparent px-3 text-xl font-bold text-ink outline-none placeholder:text-base placeholder:font-medium placeholder:text-muted"
        />
        {suffix ? <span className="flex items-center bg-surface px-3 text-base font-bold text-ink-soft">{suffix}</span> : null}
      </span>
    </label>
  );
}

/** Shown above a list that comes from the offline cache. */
export function OfflineNotice({ stale, fetchedAt }: { stale: boolean; fetchedAt: string | null }) {
  if (!stale) return null;
  return (
    <div role="status" data-testid="offline-notice" className="flex items-center gap-3 rounded-xl border-2 border-warn bg-warn-soft px-3 py-2 text-base font-bold text-warn">
      <Icon name="wifiOff" size={24} className="shrink-0" />
      <span>
        {fetchedAt ? t('floor.common.offlineList', { at: formatDateTime(fetchedAt) }) : t('floor.common.offlineNoData')}
      </span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border-2 border-dashed border-line-strong bg-paper p-4 text-center text-lg font-semibold text-muted">{children}</p>;
}

export function RefreshButton({ onClick, busy = false }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid="refresh"
      className="min-h-12 shrink-0 rounded-lg border-2 border-line-strong bg-paper px-3 text-sm font-bold text-ink active:bg-surface disabled:opacity-40"
    >
      {t('floor.common.refresh')}
    </button>
  );
}

/** Numbered step rows, same look as <ScanFlow>. */
export function StepList({ steps }: { steps: { key: string; label: string; value?: string | null; hint?: string | null; state: 'done' | 'current' | 'pending' }[] }) {
  return (
    <ol className="flex flex-col gap-2" data-testid="steps">
      {steps.map((step, i) => (
        <li
          key={step.key}
          data-step={step.key}
          data-state={step.state}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`flex min-h-14 items-center gap-3 rounded-xl border-2 px-3 py-2 ${
            step.state === 'current' ? 'border-ink bg-ink text-paper' : step.state === 'done' ? 'border-line bg-surface text-ink' : 'border-line bg-paper text-muted'
          }`}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-extrabold ${
              step.state === 'done' ? 'bg-ok text-paper' : step.state === 'current' ? 'bg-brand text-paper' : 'bg-surface text-muted'
            }`}
          >
            {step.state === 'done' ? <Icon name="check" size={20} /> : i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-bold leading-tight">{step.label}</span>
            {step.value ? (
              <span className="block truncate font-mono text-base">{step.value}</span>
            ) : step.hint ? (
              <span className="block truncate text-base font-semibold opacity-90">{step.hint}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Queued" state of a command that has not reached the server yet. */
export function QueuedBanner() {
  return (
    <Banner tone="warn" testid="queued-banner">
      {t('floor.common.queued')}
    </Banner>
  );
}
