/**
 * Admin agent: subscriber counts and trials ending. Read-only.
 *
 * Buckets come from `classifySubscriber` - the SAME classifier `/admin/subscribers`
 * renders - so the assistant's counts can never disagree with the page staff are
 * looking at. It wraps `deriveAdminBillingRow` / `resolveEffectiveManagerSkuTier`
 * (the one answer to "what plan is this account on"), so neither can drift from
 * what the product enforces, and an account whose purchase read fails is left out
 * of every bucket rather than guessed into Free. Do not add a second bucket rule
 * here: change `admin-subscribers-model.ts` and both surfaces move together.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  listAccountIdsForEveryKind,
  listSandboxAccountIds,
  loadRealAccountProfiles,
} from "@/lib/admin/admin-accounts.server";
import {
  SUBSCRIBER_TABS,
  classifySubscriber,
  subscriberCounts,
  type SubscriberBucket,
  type SubscriberCounts,
  type SubscriberRow,
} from "@/lib/admin/admin-subscribers-model";
import { readAllPages } from "@/lib/auth/admin-portal-manager-ids.server";
import { pickBestManagerPurchaseRow, type ManagerPurchaseRowRecord } from "@/lib/manager-access";
import {
  EMPTY_MANAGER_BILLING_OVERRIDES,
  loadManagerBillingOverridesForIds,
} from "@/lib/manager-billing-overrides";
import { defineTool } from "../registry";
import type { AdminAgentContext } from "./context";

export type { SubscriberBucket, SubscriberRow };

type PurchaseRow = ManagerPurchaseRowRecord & {
  email: string | null;
  promo_code: string | null;
  stripe_promotion_code: string | null;
  stripe_checkout_session_id: string | null;
  apple_original_transaction_id: string | null;
};

export async function loadManagerSubscribers(db: SupabaseClient, nowMs = Date.now()): Promise<SubscriberRow[]> {
  const [idsByKind, sandboxIds] = await Promise.all([listAccountIdsForEveryKind(db), listSandboxAccountIds(db)]);
  const managerIds = idsByKind.manager.filter((id) => !sandboxIds.has(id));
  if (managerIds.length === 0) return [];

  const [profiles, purchases, overrides] = await Promise.all([
    loadRealAccountProfiles(db, managerIds),
    readAllPages<PurchaseRow>((from, to) =>
      db
        .from("manager_purchases")
        .select(
          "id, user_id, email, tier, billing, paid_at, promo_code, stripe_promotion_code, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, apple_original_transaction_id",
        )
        .not("user_id", "is", null)
        .order("id")
        .range(from, to),
    ),
    loadManagerBillingOverridesForIds(db, managerIds),
  ]);

  const purchasesByUser = new Map<string, PurchaseRow[]>();
  for (const purchase of purchases) {
    const userId = String(purchase.user_id ?? "");
    if (!userId) continue;
    const list = purchasesByUser.get(userId) ?? [];
    list.push(purchase);
    purchasesByUser.set(userId, list);
  }

  const rows: SubscriberRow[] = [];
  for (const profile of profiles) {
    const best = pickBestManagerPurchaseRow(purchasesByUser.get(profile.id) ?? [], profile.id) as PurchaseRow | null;
    const row = classifySubscriber({
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      joinedAt: profile.joinedAt,
      purchase: best
        ? {
            tier: best.tier,
            billing: best.billing,
            paidAt: best.paid_at,
            promoCode: best.promo_code,
            stripePromotionCode: best.stripe_promotion_code,
            stripeSubscriptionId: best.stripe_subscription_id,
            stripeCustomerId: best.stripe_customer_id,
            stripeCheckoutSessionId: best.stripe_checkout_session_id,
            appleOriginalTransactionId: best.apple_original_transaction_id,
          }
        : null,
      planReadFailed: false,
      overrides: overrides.get(profile.id) ?? EMPTY_MANAGER_BILLING_OVERRIDES,
      nowMs,
    });
    // An unreadable plan is counted nowhere rather than guessed into a bucket.
    if (row) rows.push(row);
  }
  return rows;
}

export const subscriberCountsTool = defineTool({
  name: "subscriber_counts",
  description: `How many manager accounts are ${SUBSCRIBER_TABS.map((tab) => tab.label).join(", ")} right now - the same buckets /admin/subscribers shows, so a staff grant (complimentary or admin-assigned) counts as Promo code and a Stripe Checkout code on a paid subscription stays Paid. Computed from the same plan resolver the product enforces; demo accounts are excluded.`,
  inputSchema: z.object({}),
  async handler(ctx: AdminAgentContext) {
    const rows = await loadManagerSubscribers(ctx.db);
    const counts: SubscriberCounts = subscriberCounts(rows);
    return { ...counts, total: rows.length };
  },
});

const MAX_TRIALS_LISTED = 25;
const DAY_MS = 86_400_000;

export const trialsEndingTool = defineTool({
  name: "trials_ending",
  description:
    "Manager accounts whose free trial ends within the next N days (default 7), soonest first, with the end date and days left.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(60).optional().describe("Look-ahead window in days. Default 7."),
  }),
  async handler(ctx: AdminAgentContext, input) {
    const days = input.days ?? 7;
    const now = Date.now();
    const rows = await loadManagerSubscribers(ctx.db, now);
    const ending = rows
      .filter((row) => row.bucket === "trial" && row.trialEndsAt)
      .map((row) => {
        // trialEndsAt is a calendar date; the trial runs through the end of that day.
        const endMs = Date.parse(`${row.trialEndsAt!.slice(0, 10)}T23:59:59Z`);
        return { row, endMs };
      })
      .filter(({ endMs }) => Number.isFinite(endMs) && endMs >= now && endMs <= now + days * DAY_MS)
      .sort((a, b) => a.endMs - b.endMs);
    return {
      windowDays: days,
      count: ending.length,
      trials: ending.slice(0, MAX_TRIALS_LISTED).map(({ row, endMs }) => ({
        id: row.id,
        name: row.name.trim() || row.email,
        email: row.email,
        plan: row.planLabel,
        trialEndsOn: row.trialEndsAt!.slice(0, 10),
        daysLeft: Math.floor((endMs - now) / DAY_MS),
      })),
    };
  },
});
