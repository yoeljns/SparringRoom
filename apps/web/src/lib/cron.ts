import { timingSafeEqual } from 'node:crypto';

/**
 * Vercel Cron calls the route with "Authorization: Bearer <CRON_SECRET>".
 * Without a configured secret every call is refused.
 */
export function isAuthorizedCron(authorization: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
