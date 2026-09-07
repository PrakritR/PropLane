/**
 * Outbound webhook delivery.
 *
 * Wire format — one POST of `application/json` carrying:
 *   PropLane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *   PropLane-Event:     <event type>
 *   PropLane-Delivery:  <delivery id, stable across retries>
 *
 * Three things this file is responsible for and nothing else may assume:
 *
 * 1. **SSRF is re-checked at delivery time.** `checkWebhookUrl` ran at subscribe
 *    time, but DNS is not stable — the host can be re-pointed at 127.0.0.1
 *    afterwards. So the URL is re-validated AND the hostname is resolved, with
 *    every resolved address checked against the private ranges. Redirects are
 *    never followed (`redirect: "manual"`), because a 302 is the other way into
 *    the private network.
 * 2. **Emission never throws into the caller.** `enqueueWebhookEvent` is called
 *    from the middle of a work-order transition, a Stripe handler and an inbox
 *    insert. A webhook failing must never fail the thing that happened.
 * 3. **A dead endpoint stops generating traffic.** Consecutive failures across
 *    deliveries disable the subscription; the manager sees it disabled in
 *    Settings rather than PropLane retrying into the void forever.
 */
import "server-only";

import { lookup } from "node:dns/promises";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isWebhookEventType,
  webhookTestPayload,
  type WebhookEventType,
  type WebhookPayload,
} from "./events";
import {
  isWebhookSuccessStatus,
  nextWebhookAttemptAt,
  shouldDisableSubscription,
  WEBHOOK_MAX_ATTEMPTS,
} from "./retry";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  signWebhookPayload,
} from "./signature";
import { decryptWebhookSecret } from "./subscriptions.server";
import { checkWebhookUrl, isPrivateWebhookHost } from "./url-safety";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** A slow endpoint must not hold a serverless invocation open. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Deliveries a single cron pass will work through. */
const RETRY_BATCH_SIZE = 50;

const DELIVERY_COLUMNS =
  "id, subscription_id, event_type, payload, attempt, status, response_status, next_attempt_at, delivered_at, last_error";
const SUBSCRIPTION_COLUMNS = "id, manager_user_id, url, events, enabled, secret_ciphertext, failure_count";

type SubscriptionRow = {
  id: string;
  manager_user_id: string;
  url: string;
  events: unknown;
  enabled: boolean;
  secret_ciphertext: string;
  failure_count: number;
};

type DeliveryRow = {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: unknown;
  attempt: number;
};

export type WebhookAttemptOutcome = {
  ok: boolean;
  status: number | null;
  error: string | null;
};

/**
 * Resolve the hostname and refuse if ANY resolved address is private. A
 * hostname that returns both a public and a private address is refused, not
 * partially allowed — the connection picks an address we do not control.
 */
async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => !isPrivateWebhookHost(entry.address));
  } catch {
    // A hostname that does not resolve cannot be delivered to either.
    return false;
  }
}

/** One HTTP attempt. Returns an outcome; never throws. */
export async function postWebhook(args: {
  url: string;
  secret: string;
  eventType: string;
  deliveryId: string;
  payload: unknown;
  nowMs?: number;
}): Promise<WebhookAttemptOutcome> {
  const check = checkWebhookUrl(args.url);
  if (!check.ok) return { ok: false, status: null, error: `Refused: ${check.reason}` };
  if (!(await resolvesToPublicAddress(check.url.hostname))) {
    return { ok: false, status: null, error: "Refused: host resolves to a private address" };
  }

  const body = JSON.stringify({
    id: args.deliveryId,
    type: args.eventType,
    createdAt: new Date(args.nowMs ?? Date.now()).toISOString(),
    data: args.payload ?? {},
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(check.url.toString(), {
      method: "POST",
      // Never follow a redirect: it is the second door into the private network,
      // and it would also be delivered unsigned-for-that-host.
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "PropLane-Webhooks/1",
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(args.secret, body, args.nowMs ?? Date.now()),
        [WEBHOOK_EVENT_HEADER]: args.eventType,
        [WEBHOOK_DELIVERY_HEADER]: args.deliveryId,
      },
      body,
    });
    return {
      ok: isWebhookSuccessStatus(response.status),
      status: response.status,
      error: isWebhookSuccessStatus(response.status) ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delivery failed";
    return { ok: false, status: null, error: message.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

async function recordAttempt(
  db: Db,
  args: { delivery: DeliveryRow; subscription: SubscriptionRow; outcome: WebhookAttemptOutcome; now: Date },
): Promise<void> {
  const attempt = Number(args.delivery.attempt ?? 0) + 1;
  const nowIso = args.now.toISOString();

  if (args.outcome.ok) {
    await db
      .from("webhook_deliveries")
      .update({
        attempt,
        status: "delivered",
        response_status: args.outcome.status,
        delivered_at: nowIso,
        next_attempt_at: null,
        last_error: null,
      })
      .eq("id", args.delivery.id);
    // A success clears the consecutive-failure counter; an endpoint that comes
    // back must not be disabled by history.
    if (Number(args.subscription.failure_count ?? 0) > 0) {
      await db.from("webhook_subscriptions").update({ failure_count: 0 }).eq("id", args.subscription.id);
    }
    return;
  }

  const next = nextWebhookAttemptAt(attempt, args.now.getTime());
  await db
    .from("webhook_deliveries")
    .update({
      attempt,
      status: next ? "pending" : "exhausted",
      response_status: args.outcome.status,
      next_attempt_at: next ? next.toISOString() : null,
      last_error: args.outcome.error?.slice(0, 500) ?? "Delivery failed",
    })
    .eq("id", args.delivery.id);

  // Only a retired delivery counts against the subscription: counting every
  // attempt would disable an endpoint after two transient blips.
  if (!next) {
    const failures = Number(args.subscription.failure_count ?? 0) + 1;
    await db
      .from("webhook_subscriptions")
      .update({
        failure_count: failures,
        ...(shouldDisableSubscription(failures) ? { enabled: false, disabled_at: nowIso } : {}),
      })
      .eq("id", args.subscription.id);
  }
}

async function attemptDelivery(db: Db, delivery: DeliveryRow, now: Date): Promise<WebhookAttemptOutcome> {
  const { data } = await db
    .from("webhook_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", delivery.subscription_id)
    .maybeSingle();
  const subscription = data as SubscriptionRow | null;
  if (!subscription) {
    await db.from("webhook_deliveries").update({ status: "exhausted", last_error: "Subscription is gone" }).eq("id", delivery.id);
    return { ok: false, status: null, error: "Subscription is gone" };
  }
  if (subscription.enabled === false) {
    await db.from("webhook_deliveries").update({ status: "exhausted", last_error: "Subscription is disabled" }).eq("id", delivery.id);
    return { ok: false, status: null, error: "Subscription is disabled" };
  }

  let secret: string;
  try {
    secret = decryptWebhookSecret({
      managerUserId: subscription.manager_user_id,
      subscriptionId: subscription.id,
      ciphertext: subscription.secret_ciphertext,
    });
  } catch {
    // Never sign with something unverified, and never echo the keyring error.
    const outcome: WebhookAttemptOutcome = { ok: false, status: null, error: "Signing secret is unreadable" };
    await recordAttempt(db, { delivery, subscription, outcome, now });
    return outcome;
  }

  const outcome = await postWebhook({
    url: subscription.url,
    secret,
    eventType: delivery.event_type,
    deliveryId: delivery.id,
    payload: delivery.payload,
    nowMs: now.getTime(),
  });
  await recordAttempt(db, { delivery, subscription, outcome, now });
  return outcome;
}

/**
 * THE emit call. One line at each write path, and it can never throw into that
 * caller: a webhook problem must not roll back the transition that produced it.
 */
export async function enqueueWebhookEvent(
  managerUserId: string,
  type: WebhookEventType,
  payload: WebhookPayload,
): Promise<{ queued: number }> {
  try {
    const manager = String(managerUserId ?? "").trim();
    if (!manager || !isWebhookEventType(type)) return { queued: 0 };

    const db = createSupabaseServiceRoleClient();
    const { data } = await db
      .from("webhook_subscriptions")
      .select(SUBSCRIPTION_COLUMNS)
      .eq("manager_user_id", manager)
      .eq("enabled", true);
    const rows = (data ?? []) as SubscriptionRow[];
    const matching = rows.filter((row) => (Array.isArray(row.events) ? row.events : []).includes(type));
    if (matching.length === 0) return { queued: 0 };

    const now = new Date();
    let queued = 0;
    for (const subscription of matching) {
      const { data: inserted } = await db
        .from("webhook_deliveries")
        .insert({
          subscription_id: subscription.id,
          event_type: type,
          payload,
          attempt: 0,
          status: "pending",
          next_attempt_at: now.toISOString(),
        })
        .select(DELIVERY_COLUMNS)
        .single();
      if (!inserted) continue;
      queued += 1;
      // First attempt inline. A failure only schedules the retry the cron pass
      // picks up; it is already recorded on the row.
      await attemptDelivery(db, inserted as DeliveryRow, now).catch(() => undefined);
    }
    return { queued };
  } catch (error) {
    console.error("[webhooks] enqueue failed", {
      type,
      error: error instanceof Error ? error.message : "unknown",
    });
    return { queued: 0 };
  }
}

/** Cron entry point: work through deliveries whose retry time has come. */
export async function retryDueWebhookDeliveries(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const now = options.now ?? new Date();
  const { data } = await db
    .from("webhook_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("status", "pending")
    .lte("next_attempt_at", now.toISOString())
    .lt("attempt", WEBHOOK_MAX_ATTEMPTS)
    .order("next_attempt_at", { ascending: true })
    .limit(options.limit ?? RETRY_BATCH_SIZE);

  let delivered = 0;
  let failed = 0;
  const rows = (data ?? []) as DeliveryRow[];
  for (const delivery of rows) {
    const outcome = await attemptDelivery(db, delivery, now).catch(() => ({ ok: false } as WebhookAttemptOutcome));
    if (outcome.ok) delivered += 1;
    else failed += 1;
  }
  return { attempted: rows.length, delivered, failed };
}

/** "Send test event" from Settings. Same pipeline, a payload with no real data. */
export async function sendTestWebhookEvent(
  db: Db,
  args: { managerUserId: string; subscriptionId: string },
): Promise<WebhookAttemptOutcome> {
  const { data } = await db
    .from("webhook_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", args.subscriptionId)
    .eq("manager_user_id", args.managerUserId)
    .maybeSingle();
  if (!data) return { ok: false, status: null, error: "Webhook not found." };

  const now = new Date();
  const { data: inserted } = await db
    .from("webhook_deliveries")
    .insert({
      subscription_id: args.subscriptionId,
      event_type: "work_order.created",
      payload: webhookTestPayload(args.subscriptionId),
      attempt: 0,
      status: "pending",
      next_attempt_at: now.toISOString(),
    })
    .select(DELIVERY_COLUMNS)
    .single();
  if (!inserted) return { ok: false, status: null, error: "Could not record the test delivery." };
  return attemptDelivery(db, inserted as DeliveryRow, now);
}
