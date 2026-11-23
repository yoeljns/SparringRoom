import { hasMessage, t } from '@/i18n';

/**
 * Turkish text for a business refusal. Looks the code up in tr.json
 * (errors.CODE, then floor.errors.CODE); an unknown code falls back to the
 * server's own message without its "CODE: " prefix.
 */
export function errorText(code: string | undefined, serverMessage?: string | null): string {
  if (code) {
    for (const key of [`errors.${code}`, `floor.errors.${code}`]) {
      if (key !== 'errors.UNKNOWN' && hasMessage(key)) return t(key);
    }
  }
  const detail = (serverMessage ?? '').replace(/^\s*[A-Z][A-Z0-9_]{2,}:\s*/, '').trim();
  if (detail) return detail;
  return t('errors.UNKNOWN');
}
