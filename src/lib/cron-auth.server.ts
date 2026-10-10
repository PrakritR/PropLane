import "server-only";

import { isProductionRuntime } from "@/lib/server-env";

/**
 * The shared cron gate. `CRON_SECRET` set → the request must carry it as a bearer.
 * No secret configured → only a localhost/test run may proceed: preview deployments
 * are public and hold real service-role credentials, so an unsecreted cron there
 * would be an open door. Fails closed on Vercel.
 *
 * Every route under `src/app/api/cron/` whose fallback was the weaker
 * `!isProductionRuntime()` (no `!VERCEL_ENV` term, so it stayed reachable on a
 * preview deployment) now calls this. The routes that keep their own check are
 * STRICTER, not weaker: they refuse a secretless request everywhere, including
 * localhost (`sms-outbox`, `account-deletions`, `prospect-sms-bursts`,
 * `sms-inbound-recovery`, `weekly-rent-reminders`), or spell out the same
 * `!VERCEL_ENV && !isProductionRuntime()` rule beside the money it moves.
 */
export function requireCronSecret(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}
