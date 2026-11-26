import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/**
 * Where Plaid should POST. `PLAID_WEBHOOK_URL` overrides (set it on staging); otherwise the canonical
 * server origin, the same one Twilio's inbound URL is built from, and only on a production runtime.
 * Anything else returns undefined: Plaid cannot reach localhost or a preview, and the daily cron
 * (/api/cron/plaid-sync) covers a connection with no webhook.
 */
export function plaidWebhookUrl(_req?: Request, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.PLAID_WEBHOOK_URL?.trim();
  if (override) return /^https:\/\//i.test(override) ? override : undefined;
  if (env.VERCEL_ENV !== "production") return undefined;
  try {
    const url = new URL(resolveEmailLinkBaseUrl());
    return url.protocol === "https:" ? `${url.origin}/api/plaid/webhook` : undefined;
  } catch {
    return undefined;
  }
}
