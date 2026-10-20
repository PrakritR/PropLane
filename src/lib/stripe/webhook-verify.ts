import type Stripe from "stripe";

/**
 * Stripe signs a webhook with the secret of the ENDPOINT it was sent to. PropLane has two: the platform endpoint
 * (`STRIPE_WEBHOOK_SECRET`) and the Connect endpoint for connected-account events (`STRIPE_CONNECT_WEBHOOK_SECRET`:
 * account.updated, account.external_account.*, payout.*). Both post to the same route. docs/stripe-go-live.md § Webhooks.
 */
export type WebhookSecret = { source: "platform" | "connect"; secret: string };

export function stripeWebhookSecrets(env: NodeJS.ProcessEnv = process.env): WebhookSecret[] {
  const out: WebhookSecret[] = [];
  const platform = env.STRIPE_WEBHOOK_SECRET?.trim();
  const connect = env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (platform) out.push({ source: "platform", secret: platform });
  if (connect && connect !== platform) out.push({ source: "connect", secret: connect });
  return out;
}

export type VerifiedWebhook =
  | { ok: true; event: Stripe.Event; source: WebhookSecret["source"] }
  | { ok: false; error: string };

/**
 * Verify against each configured secret in turn (`stripe.webhooks.constructEvent` compares signatures in constant time and
 * enforces the timestamp tolerance). An event no secret verifies is refused; nothing is read from an unverified body.
 */
export function verifyStripeWebhookEvent(
  stripe: Pick<Stripe, "webhooks">,
  body: string,
  signature: string,
  secrets: readonly WebhookSecret[],
): VerifiedWebhook {
  let lastError = "Invalid signature";
  for (const entry of secrets) {
    try {
      const event = stripe.webhooks.constructEvent(body, signature, entry.secret);
      return { ok: true, event, source: entry.source };
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError;
    }
  }
  return { ok: false, error: lastError };
}

/** The connected-account event types the app handles. Anything else on the Connect endpoint is acknowledged and ignored. */
export const CONNECTED_ACCOUNT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "account.updated",
  "account.external_account.created",
  "account.external_account.updated",
  "account.external_account.deleted",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
]);

/** A connected-account event names its account (`event.account`) and is one of the handled types. */
export function isConnectedAccountEvent(event: Pick<Stripe.Event, "type" | "account">): boolean {
  return typeof event.account === "string" && event.account.startsWith("acct_") && CONNECTED_ACCOUNT_EVENT_TYPES.has(event.type);
}
