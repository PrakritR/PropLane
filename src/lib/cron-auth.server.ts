import "server-only";

import { isProductionRuntime } from "@/lib/server-env";

/**
 * The one cron gate. `CRON_SECRET` set → the request must carry it as a bearer.
 * No secret configured → only a localhost/test run may proceed: preview
 * deployments are public and hold real service-role credentials, so an
 * unsecreted cron there would be an open door. Fails closed on Vercel.
 */
export function requireCronSecret(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !process.env.VERCEL_ENV && !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}
