import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  ADMIN_PROFILE_ID_CHUNK,
  listAdminPortalManagerUserIds,
  loadProfilesByIdChunks,
} from "@/lib/auth/admin-portal-manager-ids.server";
import { pickBestManagerPurchaseRow, type ManagerPurchaseRowRecord } from "@/lib/manager-access";
import { deriveAdminBillingRow, type AdminBillingRowInput } from "@/lib/admin-billing-rows";
import { normalizeCommsPlanTier } from "@/lib/comms-billing/allowances";
import { loadCommsWalletTotals } from "@/lib/comms-billing/wallet.server";
import {
  EMPTY_MANAGER_BILLING_OVERRIDES,
  loadManagerBillingOverridesForIds,
} from "@/lib/manager-billing-overrides";
import { normalizeManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import { LISTING_SLOT_PROPERTY_STATUSES } from "@/lib/persisted-property-records";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * The admin Billing list: what every manager account is actually being held to.
 *
 * Read-only. Every value is derived by `deriveAdminBillingRow` from the same resolvers enforcement
 * uses, so this screen cannot quietly disagree with what a manager is charged or refused.
 *
 * It is deliberately BULK, not one fan-out per manager: six queries regardless of how many accounts
 * there are. The Accounts page already learned that lesson the expensive way — a per-row read there
 * left the page sitting on "Loading…" — and this list carries strictly more per row.
 *
 * A purchase chunk that fails to read marks only the managers in THAT chunk as `planReadFailed`,
 * which the row derivation renders as "Plan unknown". Failing the whole request would hide every
 * healthy row; rendering those rows as Free would be the one wrong answer that matters.
 */
async function requireAdminActor(): Promise<{ ok: true; actorId: string } | { ok: false }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdminUser(user.id))) return { ok: false };
  return { ok: true, actorId: user.id };
}

function currentBillingPeriodUtc(): { start: string; end: string } {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

type PurchaseRow = {
  id: string;
  email: string | null;
  user_id: string | null;
  tier: string | null;
  billing: string | null;
  paid_at: string | null;
  promo_code: string | null;
  stripe_subscription_id: string | null;
  apple_original_transaction_id: string | null;
};

const PURCHASE_SELECT =
  "id, email, user_id, tier, billing, paid_at, promo_code, stripe_subscription_id, apple_original_transaction_id";

export async function GET() {
  try {
    if (!(await requireAdminActor()).ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const db = createSupabaseServiceRoleClient();
    const allIds = await listAdminPortalManagerUserIds(db);
    if (allIds.length === 0) return NextResponse.json({ rows: [] });

    const profiles = await loadProfilesByIdChunks<{
      id: string;
      email: string | null;
      full_name: string | null;
      manager_id: string | null;
      application_approved: boolean | null;
      created_at: string | null;
    }>(db, allIds, "id, email, full_name, manager_id, application_approved, created_at");

    const visible = profiles.filter((profile) => !isPortalSandboxEmail(profile.email));
    const ids = visible.map((p) => p.id);
    const emails = visible.map((p) => String(p.email ?? "").toLowerCase()).filter(Boolean);

    // ---- purchases (by user id AND by email, exactly as the plan resolver merges them) ----
    const purchases: PurchaseRow[] = [];
    /** Ids whose plan we could not read. They become "Plan unknown", never "Free". */
    const planReadFailed = new Set<string>();
    for (let i = 0; i < ids.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = ids.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      const { data, error } = await db.from("manager_purchases").select(PURCHASE_SELECT).in("user_id", chunk);
      if (error) for (const id of chunk) planReadFailed.add(id);
      else purchases.push(...((data ?? []) as PurchaseRow[]));
    }
    const emailChunkFailed = new Set<string>();
    for (let i = 0; i < emails.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = emails.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      const { data, error } = await db.from("manager_purchases").select(PURCHASE_SELECT).in("email", chunk);
      if (error) for (const email of chunk) emailChunkFailed.add(email);
      else purchases.push(...((data ?? []) as PurchaseRow[]));
    }

    // ---- listing slots held, counted with the quota's own status set ----
    const listedCounts = new Map<string, number>();
    let slotCountFailed = false;
    for (let i = 0; i < ids.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = ids.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      const { data, error } = await db
        .from("manager_property_records")
        .select("manager_user_id")
        .in("manager_user_id", chunk)
        .in("status", [...LISTING_SLOT_PROPERTY_STATUSES]);
      // A failed count must never read as "zero used" — the same rule the cap itself follows.
      if (error) {
        slotCountFailed = true;
        continue;
      }
      for (const row of (data ?? []) as { manager_user_id: string | null }[]) {
        const owner = String(row.manager_user_id ?? "");
        if (owner) listedCounts.set(owner, (listedCounts.get(owner) ?? 0) + 1);
      }
    }

    // ---- fee settings + staff billing overrides (one row per manager, one query) ----
    const feeByManager = new Map<string, { managerChoice: string | null; adminOverride: string | null }>();
    for (let i = 0; i < ids.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = ids.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      // The settings blob lives in a `manual_payments` column where the migration has been
      // applied and inside `row_data` where it has not, so fall back rather than 500 on a
      // deployment that still uses the older shape.
      const withColumn = await db
        .from("manager_automation_settings")
        .select("manager_user_id, manual_payments, row_data")
        .in("manager_user_id", chunk);
      const { data } = withColumn.error
        ? await db.from("manager_automation_settings").select("manager_user_id, row_data").in("manager_user_id", chunk)
        : withColumn;
      for (const row of (data ?? []) as {
        manager_user_id: string;
        manual_payments?: unknown;
        row_data?: Record<string, unknown> | null;
      }[]) {
        // Both storage shapes, same as `loadManagerManualPaymentSettings` — a deployment without
        // the `manual_payments` column keeps the settings inside `row_data`.
        const settings = normalizeManagerManualPaymentSettings(
          row.manual_payments ?? row.row_data?.manualPayments,
        );
        feeByManager.set(String(row.manager_user_id), {
          managerChoice: settings.serviceFeePayer ?? null,
          adminOverride: settings.adminServiceFeeOverride ?? null,
        });
      }
    }
    const overridesById = await loadManagerBillingOverridesForIds(db, ids);

    // ---- month-to-date communication usage ----
    const { start, end } = currentBillingPeriodUtc();
    const commsUsed = new Map<string, number>();
    let commsReadFailed = false;
    for (let i = 0; i < ids.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = ids.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      const { data, error } = await db
        .from("manager_comms_usage_events")
        .select("manager_user_id, total_cents")
        .in("manager_user_id", chunk)
        .neq("credit_state", "released")
        .gte("created_at", start)
        .lt("created_at", end);
      if (error) {
        commsReadFailed = true;
        continue;
      }
      for (const row of (data ?? []) as { manager_user_id: string; total_cents: unknown }[]) {
        const owner = String(row.manager_user_id ?? "");
        if (!owner) continue;
        commsUsed.set(owner, (commsUsed.get(owner) ?? 0) + (Number(row.total_cents) || 0));
      }
    }
    const commsCard = new Set<string>();
    for (let i = 0; i < ids.length; i += ADMIN_PROFILE_ID_CHUNK) {
      const chunk = ids.slice(i, i + ADMIN_PROFILE_ID_CHUNK);
      const { data } = await db
        .from("manager_comms_billing_accounts")
        .select("manager_user_id, has_default_payment_method")
        .in("manager_user_id", chunk);
      for (const row of (data ?? []) as {
        manager_user_id: string;
        has_default_payment_method: boolean | null;
      }[]) {
        if (row.has_default_payment_method) commsCard.add(String(row.manager_user_id));
      }
    }

    const inputs = visible.map((profile): AdminBillingRowInput => {
      const email = String(profile.email ?? "").toLowerCase();
      const candidates = purchases.filter(
        (p) => p.user_id === profile.id || String(p.email ?? "").toLowerCase() === email,
      );
      const deduped = new Map<string, ManagerPurchaseRowRecord>();
      for (const row of candidates) {
        deduped.set(String(row.id), {
          id: String(row.id),
          tier: row.tier,
          billing: row.billing,
          paid_at: row.paid_at,
          user_id: row.user_id,
          promo_code: row.promo_code,
          apple_original_transaction_id: row.apple_original_transaction_id,
          // Not selected — nothing this list derives reads them, and the row picker sorts on
          // `paid_at` alone.
          stripe_customer_id: null,
          stripe_subscription_id: row.stripe_subscription_id,
          stripe_checkout_session_id: null,
        });
      }
      const best = pickBestManagerPurchaseRow([...deduped.values()], profile.id);
      const fees = feeByManager.get(profile.id) ?? { managerChoice: null, adminOverride: null };

      const input: AdminBillingRowInput = {
        id: profile.id,
        email: profile.email ?? "",
        fullName: profile.full_name ?? "",
        managerId: profile.manager_id ?? "",
        active: profile.application_approved !== false,
        joinedAt: profile.created_at ?? best?.paid_at ?? null,
        purchase: best
          ? {
              tier: best.tier,
              billing: best.billing,
              paidAt: best.paid_at,
              stripeSubscriptionId: best.stripe_subscription_id,
              appleOriginalTransactionId: best.apple_original_transaction_id ?? null,
              promoCode: best.promo_code ?? null,
            }
          : null,
        planReadFailed: planReadFailed.has(profile.id) || (Boolean(email) && emailChunkFailed.has(email)),
        listedCount: slotCountFailed ? null : (listedCounts.get(profile.id) ?? 0),
        overrides: overridesById.get(profile.id) ?? EMPTY_MANAGER_BILLING_OVERRIDES,
        managerFeeChoice: (fees.managerChoice as AdminBillingRowInput["managerFeeChoice"]) ?? null,
        adminFeeOverride: (fees.adminOverride as AdminBillingRowInput["adminFeeOverride"]) ?? null,
        commsUsedCents: commsReadFailed ? null : (commsUsed.get(profile.id) ?? 0),
        commsWallet: null,
        commsHasPaymentMethod: commsCard.has(profile.id),
      };
      return input;
    });

    // ---- prepaid wallet totals, computed by the same snapshot the dispatcher spends from ----
    // The wallet's grant depends on the enforced plan, so derive the plan first and ask for every
    // readable owner in one round trip. A row whose wallet could not be read shows "comms —".
    const provisional = inputs.map((input) => deriveAdminBillingRow(input));
    const walletOwners = provisional.flatMap((row) =>
      row.planUnknown ? [] : [{ managerUserId: row.id, tier: normalizeCommsPlanTier(row.tier) }],
    );
    const wallets = await loadCommsWalletTotals(db, walletOwners);
    const rows = inputs.map((input) =>
      deriveAdminBillingRow({ ...input, commsWallet: wallets.get(input.id) ?? null }),
    );

    rows.sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
