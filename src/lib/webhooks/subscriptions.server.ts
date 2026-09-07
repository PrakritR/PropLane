/**
 * Webhook subscription lifecycle — list, create, rotate, delete.
 *
 * The signing secret is ENCRYPTED at rest with the application keyring
 * (`src/lib/security/data-encryption.ts`), not hashed: PropLane has to
 * reproduce it to sign every delivery, so a one-way digest cannot work here the
 * way it does for an API key. The encryption context binds the ciphertext to
 * the owning manager AND the row id, so a secret lifted onto another row (or
 * another manager's row) fails to decrypt rather than silently signing.
 *
 * The plaintext exists in exactly two places: the return value of
 * `createWebhookSubscription` / `rotateWebhookSecret`, and the delivery path's
 * in-memory decrypt. It is never logged and never returned by `list`.
 */
import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/security/data-encryption";
import { normalizeWebhookEvents, type WebhookEventType } from "./events";
import { checkWebhookUrl } from "./url-safety";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

const SECRET_PREFIX = "whsec_";
const ENCRYPTION_PURPOSE = "webhook_signing_secret";
const SECRET_FIELD = "secret_ciphertext";

export const WEBHOOK_SUBSCRIPTION_COLUMNS =
  "id, manager_user_id, url, events, enabled, created_at, disabled_at, failure_count";

export type WebhookSubscription = {
  id: string;
  managerUserId: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  disabledAt: string | null;
  failureCount: number;
};

/** What the panel shows per subscription — never the secret. */
export type WebhookSubscriptionView = WebhookSubscription & {
  lastDelivery: { eventType: string; status: string; responseStatus: number | null; at: string | null } | null;
};

function newSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function encryptionContext(managerUserId: string, subscriptionId: string) {
  return {
    purpose: ENCRYPTION_PURPOSE,
    ownerId: managerUserId,
    recordId: subscriptionId,
    field: SECRET_FIELD,
  };
}

function rowToSubscription(row: Record<string, unknown>): WebhookSubscription {
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id ?? ""),
    url: String(row.url ?? ""),
    events: normalizeWebhookEvents(row.events),
    enabled: row.enabled !== false,
    createdAt: String(row.created_at ?? ""),
    disabledAt: row.disabled_at ? String(row.disabled_at) : null,
    failureCount: Number(row.failure_count ?? 0),
  };
}

export async function listWebhookSubscriptions(
  db: Db,
  managerUserId: string,
): Promise<WebhookSubscriptionView[]> {
  const { data } = await db
    .from("webhook_subscriptions")
    .select(WEBHOOK_SUBSCRIPTION_COLUMNS)
    .eq("manager_user_id", managerUserId)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as Record<string, unknown>[];
  const subscriptions = rows.map(rowToSubscription);
  if (subscriptions.length === 0) return [];

  const { data: deliveries } = await db
    .from("webhook_deliveries")
    .select("subscription_id, event_type, status, response_status, delivered_at, created_at")
    .in("subscription_id", subscriptions.map((subscription) => subscription.id))
    .order("created_at", { ascending: false })
    .limit(200);

  const latest = new Map<string, WebhookSubscriptionView["lastDelivery"]>();
  for (const row of (deliveries ?? []) as Record<string, unknown>[]) {
    const key = String(row.subscription_id ?? "");
    if (!key || latest.has(key)) continue;
    latest.set(key, {
      eventType: String(row.event_type ?? ""),
      status: String(row.status ?? ""),
      responseStatus: row.response_status === null || row.response_status === undefined ? null : Number(row.response_status),
      at: row.delivered_at ? String(row.delivered_at) : row.created_at ? String(row.created_at) : null,
    });
  }
  return subscriptions.map((subscription) => ({
    ...subscription,
    lastDelivery: latest.get(subscription.id) ?? null,
  }));
}

export type CreateWebhookResult =
  | { ok: true; subscription: WebhookSubscription; secret: string }
  | { ok: false; error: string };

/**
 * The URL is re-validated here even though the route already checked it: this
 * function is the only writer, so the guard belongs where the row is created
 * rather than only on the path that happens to call it today.
 */
export async function createWebhookSubscription(
  db: Db,
  args: { managerUserId: string; url: string; events: unknown },
): Promise<CreateWebhookResult> {
  const check = checkWebhookUrl(args.url);
  if (!check.ok) return { ok: false, error: check.message };
  const events = normalizeWebhookEvents(args.events);
  if (events.length === 0) return { ok: false, error: "Choose at least one event to send." };

  // The id is minted here rather than by the database default so the secret can
  // be bound to it before the row exists.
  const id = randomUUID();
  const secret = newSecret();
  const { data, error } = await db
    .from("webhook_subscriptions")
    .insert({
      id,
      manager_user_id: args.managerUserId,
      url: check.url.toString(),
      events,
      secret_ciphertext: encryptSensitiveValue(secret, encryptionContext(args.managerUserId, id)),
      enabled: true,
    })
    .select(WEBHOOK_SUBSCRIPTION_COLUMNS)
    .single();
  if (error || !data) {
    // The secret is deliberately absent from this log line.
    console.error("[webhooks] subscription insert failed", { error: error?.message ?? "no row returned" });
    return { ok: false, error: "Could not save that webhook." };
  }
  return { ok: true, subscription: rowToSubscription(data as Record<string, unknown>), secret };
}

/** Mint a fresh secret for an existing row. Returns null when the row is not this manager's. */
export async function rotateWebhookSecret(
  db: Db,
  args: { managerUserId: string; id: string },
): Promise<{ subscription: WebhookSubscription; secret: string } | null> {
  const secret = newSecret();
  const { data, error } = await db
    .from("webhook_subscriptions")
    .update({
      secret_ciphertext: encryptSensitiveValue(secret, encryptionContext(args.managerUserId, args.id)),
    })
    .eq("id", args.id)
    .eq("manager_user_id", args.managerUserId)
    .select(WEBHOOK_SUBSCRIPTION_COLUMNS)
    .maybeSingle();
  if (error || !data) return null;
  return { subscription: rowToSubscription(data as Record<string, unknown>), secret };
}

export async function deleteWebhookSubscription(
  db: Db,
  args: { managerUserId: string; id: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("webhook_subscriptions")
    .delete()
    .eq("id", args.id)
    .eq("manager_user_id", args.managerUserId)
    .select("id")
    .maybeSingle();
  return !error && Boolean(data);
}

export async function getWebhookSubscription(
  db: Db,
  args: { managerUserId: string; id: string },
): Promise<WebhookSubscription | null> {
  const { data } = await db
    .from("webhook_subscriptions")
    .select(WEBHOOK_SUBSCRIPTION_COLUMNS)
    .eq("id", args.id)
    .eq("manager_user_id", args.managerUserId)
    .maybeSingle();
  return data ? rowToSubscription(data as Record<string, unknown>) : null;
}

/**
 * Decrypt for signing. Throws on a tampered, mis-keyed or wrong-row ciphertext
 * — the delivery path treats that as a failed attempt rather than signing with
 * something unverified.
 */
export function decryptWebhookSecret(args: {
  managerUserId: string;
  subscriptionId: string;
  ciphertext: string;
}): string {
  return decryptSensitiveValue(
    args.ciphertext,
    encryptionContext(args.managerUserId, args.subscriptionId),
  );
}
