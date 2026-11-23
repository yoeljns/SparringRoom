/** Wordmark: red block with a white D, then the name. Colours come from the theme tokens. */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-brand font-black leading-none text-paper"
      style={{ width: size, height: size, fontSize: size * 0.62 }}
    >
      D
    </span>
  );
}

export function Brand({ label, tone = 'dark', size = 36 }: { label: string; tone?: 'dark' | 'light'; size?: number }) {
  return (
    <span className="inline-flex items-center gap-3">
      <BrandMark size={size} />
      <span className={`text-lg font-extrabold uppercase tracking-[0.14em] ${tone === 'dark' ? 'text-paper' : 'text-ink'}`}>
        {label}
      </span>
    </span>
  );
}
