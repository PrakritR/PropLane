import "server-only";

import { isProductionRuntime } from "@/lib/server-env";

/**
 * Shared gate for the growth and reminder crons (`growth-engage`, `growth-insights`,
 * `growth-publish`, `growth-draft`, `dispatch-reminders`). `CRON_SECRET` set → the
 * request must carry it as a bearer. No secret configured → only a localhost/test run
 * may proceed: preview deployments are public and hold real service-role credentials,
 * so an unsecreted cron there would be an open door. Fails closed on Vercel.
 *
 * TODO: the other routes under `src/app/api/cron/` still carry their own `isAuthorized`
 * copy and have not been migrated to this helper; `action-event-deliveries` is missing
 * the `!VERCEL_ENV` term and is the weakest of them.
 */
export function requireCronSecret(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}
