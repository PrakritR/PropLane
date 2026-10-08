/**
 * Pure model for Accounts > Subscribers. Which bucket an account is in is decided
 * by the SAME resolvers enforcement uses - `deriveAdminBillingRow` runs
 * `resolveEffectiveManagerSkuTier` (lapsed trial -> Free, live Stripe/Apple grant
 * authoritative) and the staff billing overrides - so this list cannot disagree
 * with what a manager is actually held to. See docs/agents/plan-entitlements.md.
 *
 * Buckets are mutually exclusive, first match wins:
 *   1. complimentary - the staff "complimentary" override, or an admin/portal grant
 *      that no payment is behind (`billing: admin|portal`, `admin_` checkout id)
 *   2. trial         - a live signup trial (`billing: trial`, not yet expired)
 *   3. promo         - a paid plan reached with a promo code / waiver
 *   4. paid          - a Stripe or Apple subscription (or a paid tier with no committed row)
 *   5. free          - Free, including a lapsed trial
 * An account whose purchase could not be read is `unknown` and is counted nowhere:
 * "no committed SKU" and "read failed" both produce zero rows, and filing the second
 * as Free would be the one wrong guess that matters.
 */
import { deriveAdminBillingRow, type AdminBillingRow } from "@/lib/admin-billing-rows";
import { isAdminManagedManagerPurchase } from "@/lib/manager-admin-purchase";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import type { ManagerSkuTier } from "@/lib/manager-access";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { csvCell } from "@/lib/admin/admin-revenue-model";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { EMPTY_MANAGER_BILLING_OVERRIDES, type ManagerBillingOverrides } from "@/lib/manager-billing-overrides";

import {
  SUBSCRIBER_TABS,
  subscriberTabFromParam,
  trialEndsSoon,
  type SubscriberBucket,
  type SubscriberCounts,
  type SubscriberRow,
  type SubscriberSource,
} from "@/lib/admin/admin-subscribers-shared";

export { SUBSCRIBER_TABS, subscriberTabFromParam, trialEndsSoon };
export type { SubscriberBucket, SubscriberCounts, SubscriberRow, SubscriberSource };

export type SubscriberPurchase = {
  tier: string | null;
  billing: string | null;
  paidAt: string | null;
  promoCode: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  stripeCheckoutSessionId: string | null;
  appleOriginalTransactionId: string | null;
};

export type SubscriberInput = {
  /** Manager user id. */
  id: string;
  email: string;
  fullName: string;
  joinedAt: string | null;
  purchase: SubscriberPurchase | null;
  /** The purchase read failed for this account. */
  planReadFailed: boolean;
  overrides: ManagerBillingOverrides;
  nowMs: number;
};

const TIER_LABEL: Record<string, string> = { free: "Free", pro: "Pro", business: "Business" };
const MS_PER_DAY = 86_400_000;

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function subscriberSource(purchase: SubscriberPurchase | null): SubscriberSource {
  if (purchase && isAppleBilledManagerPurchase(purchase.billing, purchase.appleOriginalTransactionId)) return "app_store";
  if (trimmed(purchase?.stripeSubscriptionId)) return "stripe";
  return "proplane";
}

/** A grant with no payment behind it: staff-assigned, not bought. */
function isAdminGrant(purchase: SubscriberPurchase | null): boolean {
  if (!purchase) return false;
  const billing = trimmed(purchase.billing).toLowerCase();
  return billing === "admin" || billing === "portal" || isAdminManagedManagerPurchase(purchase.stripeCheckoutSessionId);
}

/** The monthly equivalent of a paid plan at list price (base plan; per-door overage is not included). */
export function monthlyCentsForPlan(tier: ManagerSkuTier | null, billing: string | null): number | null {
  if (tier !== "pro" && tier !== "business") return null;
  const card = RATE_CARD[tier];
  return trimmed(billing).toLowerCase() === "annual" ? Math.round(card.floorAnnualCents / 12) : card.floorMonthlyCents;
}

function planLabelOf(derived: AdminBillingRow, purchase: SubscriberPurchase | null, bucket: SubscriberBucket): string {
  if (derived.tier === null) return derived.planLabel;
  const name = TIER_LABEL[derived.tier] ?? derived.planLabel;
  if (derived.tier === "free") return name;
  if (bucket === "trial") return `${name} trial`;
  const billing = trimmed(purchase?.billing).toLowerCase();
  return billing === "monthly" || billing === "annual" ? `${name} ${billing}` : name;
}

/** Calendar days (Pacific "today") until the `YYYY-MM-DD` trial end, floored at 0. */
export function trialDaysLeft(trialEndsAt: string, nowMs: number): number | null {
  const endMs = Date.parse(`${trialEndsAt.slice(0, 10)}T00:00:00Z`);
  const todayMs = Date.parse(`${pacificCalendarDateYmd(nowMs)}T00:00:00Z`);
  if (!Number.isFinite(endMs) || !Number.isFinite(todayMs)) return null;
  return Math.max(0, Math.round((endMs - todayMs) / MS_PER_DAY));
}

/**
 * Classify one manager. Returns `null` for an account whose plan could not be read:
 * it is excluded from every tab and count instead of being guessed.
 */
export function classifySubscriber(input: SubscriberInput): SubscriberRow | null {
  const purchase = input.purchase;
  const derived = deriveAdminBillingRow({
    id: input.id,
    email: input.email,
    fullName: input.fullName,
    managerId: "",
    active: true,
    joinedAt: input.joinedAt,
    purchase: purchase
      ? {
          tier: purchase.tier,
          billing: purchase.billing,
          paidAt: purchase.paidAt,
          stripeSubscriptionId: purchase.stripeSubscriptionId,
          appleOriginalTransactionId: purchase.appleOriginalTransactionId,
          promoCode: purchase.promoCode,
        }
      : null,
    planReadFailed: input.planReadFailed,
    listedCount: null,
    overrides: input.overrides ?? EMPTY_MANAGER_BILLING_OVERRIDES,
    managerFeeChoice: null,
    adminFeeOverride: null,
    commsUsedCents: null,
    commsWallet: null,
    commsHasPaymentMethod: false,
    nowMs: input.nowMs,
  });
  if (derived.planUnknown) return null;

  const paidTier = derived.tier === "pro" || derived.tier === "business";
  const promoCode = trimmed(purchase?.promoCode) || null;
  const grant = isAdminGrant(purchase);
  const source = subscriberSource(purchase);

  let bucket: SubscriberBucket;
  if (input.overrides.complimentary || (grant && (paidTier || derived.tier === null))) bucket = "complimentary";
  else if (derived.onTrial) bucket = "trial";
  else if (promoCode && paidTier) bucket = "promo";
  else if (paidTier || derived.tier === null) bucket = "paid";
  else bucket = "free";

  const trialEndsAt = bucket === "trial" ? derived.trialEndsAt : null;
  return {
    id: input.id,
    accountKey: `manager-${input.id}`,
    email: input.email,
    name: input.fullName,
    bucket,
    tier: derived.tier,
    planLabel: planLabelOf(derived, purchase, bucket),
    source,
    since: purchase?.paidAt ?? input.joinedAt,
    trialEndsAt,
    trialDaysLeft: trialEndsAt ? trialDaysLeft(trialEndsAt, input.nowMs) : null,
    promoCode,
    monthlyCents: bucket === "paid" || bucket === "promo" ? monthlyCentsForPlan(derived.tier, purchase?.billing ?? null) : null,
    stripeSubscriptionId: trimmed(purchase?.stripeSubscriptionId) || null,
    stripeCustomerId: trimmed(purchase?.stripeCustomerId) || null,
    renewsAt: null,
  };
}

export function subscriberCounts(rows: readonly SubscriberRow[]): SubscriberCounts {
  const counts: SubscriberCounts = { paid: 0, trial: 0, promo: 0, free: 0, complimentary: 0 };
  for (const row of rows) counts[row.bucket] += 1;
  return counts;
}

/** Monthly recurring revenue at list price: only accounts in the Paid bucket count. */
export function subscriberMrrCents(rows: readonly SubscriberRow[]): number {
  let total = 0;
  for (const row of rows) if (row.bucket === "paid") total += row.monthlyCents ?? 0;
  return total;
}

export type SubscriberFilters = {
  tab: SubscriberBucket;
  q: string;
  /** `all` | `pro` | `business` */
  plan: "all" | "pro" | "business";
  source: "all" | SubscriberSource;
  /** `YYYY-MM` of the sign-up/start date, or empty for any. */
  signup: string;
};

export function filterSubscribers(rows: readonly SubscriberRow[], filters: SubscriberFilters): SubscriberRow[] {
  const needle = filters.q.trim().toLowerCase();
  const out = rows.filter((row) => {
    if (row.bucket !== filters.tab) return false;
    if (filters.plan !== "all" && row.tier !== filters.plan) return false;
    if (filters.source !== "all" && row.source !== filters.source) return false;
    if (filters.signup && !(row.since ?? "").startsWith(filters.signup)) return false;
    if (needle && !`${row.name} ${row.email} ${row.promoCode ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  // Trials: soonest end first. Everything else: most recently started first.
  return out.sort((a, b) =>
    filters.tab === "trial"
      ? (a.trialEndsAt ?? "9999").localeCompare(b.trialEndsAt ?? "9999") || a.email.localeCompare(b.email)
      : (b.since ?? "").localeCompare(a.since ?? "") || a.email.localeCompare(b.email),
  );
}

const SOURCE_LABEL: Record<SubscriberSource, string> = {
  stripe: "Stripe",
  app_store: "App Store",
  proplane: "PropLane",
};

export function subscriberSourceLabel(source: SubscriberSource): string {
  return SOURCE_LABEL[source];
}

/** The Download CSV for a filtered Subscribers list (every row, not one page). */
export function subscribersToCsv(rows: readonly SubscriberRow[]): string {
  const lines = ["Name,Email,Status,Plan,Since,Trial ends,Promo code,Monthly,Billing source,Stripe subscription"];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.name),
        csvCell(row.email),
        csvCell(row.bucket),
        csvCell(row.planLabel),
        csvCell(row.since ? row.since.slice(0, 10) : ""),
        csvCell(row.trialEndsAt),
        csvCell(row.promoCode),
        row.monthlyCents === null ? "" : (row.monthlyCents / 100).toFixed(2),
        csvCell(SOURCE_LABEL[row.source]),
        csvCell(row.stripeSubscriptionId),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
