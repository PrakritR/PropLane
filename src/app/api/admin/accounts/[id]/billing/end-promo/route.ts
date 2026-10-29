import { NextResponse } from "next/server";
import { isAdminAccountId } from "@/lib/admin/admin-account-detail.server";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { resolveExpiryInstant } from "@/lib/admin/admin-promo-expiry.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { normalizeAdminAuditReason, writeAdminBillingAudit } from "@/lib/admin-billing-audit.server";
import { invalidateManagerTierCache } from "@/lib/manager-tier-sync-cache";
import { loadAccountPurchaseRows } from "@/lib/manager-purchase-account-rows.server";
import { isWaiverOnlyGrant, promoPolicyKey } from "@/lib/promo-code-expiry";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

type PurchaseRow = {
  id: string;
  user_id: string | null;
  tier: string | null;
  billing: string | null;
  promo_code: string | null;
  promo_ends_at: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  apple_original_transaction_id: string | null;
};

/**
 * POST /api/admin/accounts/[id]/billing/end-promo — `{ endsAt: "now" | "YYYY-MM-DD", reason }`.
 *
 * Ends the payment-waiver promo on ONE account: sets `manager_purchases.promo_ends_at`. From that instant the
 * account's waiver grant resolves to Free ("Your FREE100 access ended. Choose a plan to keep going.") and the
 * code will not redeem on it again. The stored plan is never rewritten, so a future date changes nothing until
 * it arrives. An account paid by Stripe/Apple, comped by an admin or on a signup trial has no waiver grant to
 * end: the end date is recorded but changes nothing (`appliesTo: "recorded_only"`).
 *
 * Admin-only (401 / 403), a UUID path id (never authorization on its own), a required reason, and the audit row
 * is written BEFORE the change: a failed audit write refuses the action.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const { id: rawId } = await ctx.params;
    const managerUserId = decodeURIComponent(rawId ?? "").trim();
    if (!isAdminAccountId(managerUserId)) return json({ error: "Account not found." }, 404);

    const body = (await req.json().catch(() => null)) as { endsAt?: unknown; reason?: unknown } | null;
    const reason = normalizeAdminAuditReason(body?.reason);
    if (!reason) return json({ error: "A reason is required." }, 400);
    const endsAtRaw = typeof body?.endsAt === "string" ? body.endsAt : "";
    if (!endsAtRaw.trim()) return json({ error: "Say when the promo ends." }, 400);

    let endsMs: number;
    try {
      endsMs = resolveExpiryInstant(endsAtRaw);
    } catch (error) {
      if (error instanceof AdminInputError) return json({ error: error.message }, error.status);
      throw error;
    }
    const endsIso = new Date(endsMs).toISOString();

    const db = createSupabaseServiceRoleClient();
    // The same lookup the plan resolver uses: a pre-auth signup row carries the email and no `user_id`,
    // and it is the row that grants Pro, so a `user_id`-only read would leave that promo unendable.
    const { rows, readFailed } = await loadAccountPurchaseRows<PurchaseRow>(
      db,
      managerUserId,
      "id, user_id, tier, billing, promo_code, promo_ends_at, stripe_subscription_id, stripe_checkout_session_id, apple_original_transaction_id",
    );
    if (readFailed) {
      console.error("end-promo: purchase read failed");
      return json({ error: "Could not read this account's billing." }, 500);
    }
    const withCode = rows.filter((row) => promoPolicyKey(row.promo_code));
    if (withCode.length === 0) return json({ error: "This account has no promo code to end." }, 409);

    const before = withCode.map((row) => row.promo_ends_at).find((v) => Boolean(v)) ?? null;
    const audit = await writeAdminBillingAudit({
      db,
      actorUserId: gate.userId,
      managerUserId,
      entries: [{ field: "promoEndsAt", before, after: endsIso }],
      reason,
    });
    if (!audit.ok) return json({ error: "Could not record the audit entry, so nothing was changed. Try again." }, 500);

    const { error: writeError } = await db
      .from("manager_purchases")
      .update({ promo_ends_at: endsIso })
      .in("id", withCode.map((row) => row.id));
    if (writeError) {
      console.error("end-promo: write failed", writeError);
      return json({ error: "Could not save that change." }, 500);
    }
    invalidateManagerTierCache(managerUserId);

    const waiverGrant = withCode.some((row) =>
      isWaiverOnlyGrant({
        promoCode: row.promo_code,
        billing: row.billing,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        appleOriginalTransactionId: row.apple_original_transaction_id,
      }),
    );
    return json({
      ok: true,
      auditRecorded: true,
      endsAt: endsIso,
      accessEnded: waiverGrant && endsMs <= Date.now(),
      appliesTo: waiverGrant ? "waiver_grant" : "recorded_only",
    });
  } catch (e) {
    console.error("POST /api/admin/accounts/[id]/billing/end-promo failed", e);
    return json({ error: "Could not end this account's promo." }, 500);
  }
}
