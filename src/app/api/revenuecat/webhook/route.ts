import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { track } from "@/lib/analytics/posthog";
import { applyRevenueCatWebhookEvent } from "@/lib/manager-apple-subscription-sync";
import type { RevenueCatWebhookEvent } from "@/lib/manager-apple-webhook";
import { reconcileManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * RevenueCat webhook → Apple entitlement sync.
 *
 * RevenueCat authenticates its webhooks with a shared secret you configure in
 * the dashboard (Project → Integrations → Webhooks → "Authorization header
 * value"); it sends that value verbatim as the `Authorization` header on every
 * POST. We verify it constant-time against `REVENUECAT_WEBHOOK_AUTH_HEADER`.
 *
 * The handler is idempotent: applying an event upserts/downgrades to the target
 * state (never a delta), so RevenueCat's at-least-once redelivery is safe.
 * Non-2xx triggers RevenueCat's retry, so real (transient) failures throw → 500.
 * See docs/agents/apple-iap.md.
 */

function safeHeaderEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER?.trim();
  if (!expected) {
    return NextResponse.json({ error: "Missing REVENUECAT_WEBHOOK_AUTH_HEADER" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!safeHeaderEqual(authHeader, expected)) {
    return NextResponse.json({ error: "Invalid authorization" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { event?: RevenueCatWebhookEvent } | null;
  const event = body?.event;
  if (!event || typeof event !== "object") {
    // Malformed / non-event ping — acknowledge so RevenueCat stops retrying.
    return NextResponse.json({ received: true, action: "ignore" }, { status: 200 });
  }

  try {
    const { decision } = await applyRevenueCatWebhookEvent(event);
    if (decision.action !== "ignore") {
      const smsEntitlement = await reconcileManagerSmsEntitlement(
        createSupabaseServiceRoleClient(),
        decision.appUserId,
      );
      if (!smsEntitlement.eligible && smsEntitlement.reason === "plan_unreadable") {
        throw new Error("SMS entitlement reconciliation failed after Apple subscription event.");
      }
    }
    // Server-confirmed conversion — mirror the Stripe `manager_subscription_purchased`
    // event. Fire only on the initial purchase (not every renewal); ids/enums only.
    if (decision.action === "grant" && String(event.type ?? "").trim().toUpperCase() === "INITIAL_PURCHASE") {
      track("manager_subscription_purchased", decision.appUserId, {
        tier: decision.tier,
        billing: "apple",
        platform: "ios",
      });
    }
    return NextResponse.json({ received: true, action: decision.action }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Webhook handler error";
    // 500 → RevenueCat retries with backoff.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
