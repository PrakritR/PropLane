import {
  isWaiverGrantedManagerPurchase,
  maxPropertiesForManagerTier,
  normalizeManagerSkuTier,
  resolveEffectiveManagerSkuTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { isAppleBilledManagerPurchase } from "@/lib/manager-apple-purchase";
import { isSignupTrialManagerPurchase, managerPurchasePeriodEndMs } from "@/lib/manager-tier-expiry";
import {
  evaluateCommsAllowance,
  normalizeCommsPlanTier,
  type CommsAllowanceState,
} from "@/lib/comms-billing/allowances";
import { resolveServiceFeePayerFor, type ServiceFeePayer } from "@/lib/payment-policy";
import {
  resolveManagerPropertyCap,
  type ManagerBillingOverrides,
  EMPTY_MANAGER_BILLING_OVERRIDES,
} from "@/lib/manager-billing-overrides";

/**
 * One row of the admin Billing list.
 *
 * Every number here comes from the resolver the product actually enforces — `resolveEffectiveManagerSkuTier`
 * for the plan, `maxPropertiesForManagerTier` + the staff cap override for the limit, the same
 * listing-slot statuses the quota counts, `resolveServiceFeePayerFor` for who pays processing, and
 * the comms allowance table for usage. A staff screen that computed any of them a second way would
 * eventually disagree with what the manager is charged, which is the whole failure this list exists
 * to make visible.
 *
 * The one state this file is most careful about is `planUnknown`. Zero purchase rows come back both
 * when an account never bought anything and when the read failed, and the first resolves to Free —
 * so a list that rendered "Free" for an unreadable plan would tell staff a Business customer is on
 * the free tier. An unreadable plan shows "Plan unknown" and suppresses every number derived from
 * it, rather than guessing.
 */

export type AdminBillingPurchaseInput = {
  tier: string | null;
  billing: string | null;
  paidAt: string | null;
  stripeSubscriptionId: string | null;
  appleOriginalTransactionId: string | null;
  promoCode: string | null;
};

export type AdminBillingRowInput = {
  id: string;
  email: string;
  fullName: string;
  managerId: string;
  /** Login enabled. Carried so the row can open the shared account editor without a second read. */
  active: boolean;
  joinedAt: string | null;
  /** `null` when this account has no purchase row at all. */
  purchase: AdminBillingPurchaseInput | null;
  /** The purchase read itself failed for this account — NOT "there is no purchase row". */
  planReadFailed: boolean;
  /** Listing slots held right now, counted the same way the quota counts them. `null` = uncounted. */
  listedCount: number | null;
  overrides: ManagerBillingOverrides;
  /** The manager's own account-wide fee-payer choice, if they have made one. */
  managerFeeChoice: ServiceFeePayer | null;
  /** PropLane staff's fee-payer override, if set. */
  adminFeeOverride: ServiceFeePayer | null;
  /** Month-to-date communication usage in cents. `null` when the usage read is unavailable. */
  commsUsedCents: number | null;
  commsHasPaymentMethod: boolean;
  nowMs?: number;
};

export type AdminBillingRow = {
  id: string;
  email: string;
  fullName: string;
  managerId: string;
  active: boolean;
  joinedAt: string | null;
  /**
   * The RAW stored SKU. The account editor's Plan select edits this, NOT `tier` — `tier` is the
   * plan the product enforces after trial expiry, and writing that back would silently commit a
   * lapsed trial to Free.
   */
  storedTier: string;
  /** The enforced plan. `null` with `planUnknown: false` means a legacy, uncapped account. */
  tier: ManagerSkuTier | null;
  planUnknown: boolean;
  planLabel: string;
  /** On a signup trial right now. */
  onTrial: boolean;
  /** Was on a signup trial and it has run out — the row still stores pro/business forever. */
  trialLapsed: boolean;
  /** ISO date of the trial end, staff override first, otherwise the derived signup-trial end. */
  trialEndsAt: string | null;
  trialEndIsOverride: boolean;
  /** Listing cap actually enforced. `null` = uncapped. */
  propertyLimit: number | null;
  propertyLimitIsOverride: boolean;
  listedCount: number | null;
  /** At or past the cap — the next listing is refused. */
  atPropertyLimit: boolean;
  /** Net answer for who pays processing; `null` when the plan could not be read. */
  serviceFeePayer: ServiceFeePayer | null;
  /** PropLane bears Stripe's cost for this account. */
  proplaneAbsorbsFees: boolean;
  feeOverrideSetByStaff: boolean;
  complimentary: boolean;
  /** `null` when usage could not be read; the screen shows "—" rather than a wrong zero. */
  comms: CommsAllowanceState | null;
};

const PLAN_LABELS: Record<ManagerSkuTier, string> = { free: "Free", pro: "Pro", business: "Business" };

export function deriveAdminBillingRow(input: AdminBillingRowInput): AdminBillingRow {
  const nowMs = input.nowMs ?? Date.now();
  const overrides = input.overrides ?? EMPTY_MANAGER_BILLING_OVERRIDES;
  const purchase = input.purchase;

  // An unreadable plan is not the Free plan. Everything derived from the tier is withheld rather
  // than computed from a guess, so nothing on this screen can read as a settled fact it is not.
  const planUnknown = input.planReadFailed;
  const tier = planUnknown
    ? null
    : resolveEffectiveManagerSkuTier({
        tier: purchase?.tier ?? null,
        stripeSubscriptionId: purchase?.stripeSubscriptionId ?? null,
        appleManaged: isAppleBilledManagerPurchase(
          purchase?.billing ?? null,
          purchase?.appleOriginalTransactionId ?? null,
        ),
        billing: purchase?.billing ?? null,
        paidAt: purchase?.paidAt ?? null,
        nowMs,
      });

  const isTrialRow = !planUnknown && isSignupTrialManagerPurchase(purchase?.billing ?? null);
  const derivedTrialEndMs = isTrialRow
    ? managerPurchasePeriodEndMs(
        {
          tier: purchase?.tier ?? null,
          billing: purchase?.billing ?? null,
          paid_at: purchase?.paidAt ?? null,
          stripe_subscription_id: purchase?.stripeSubscriptionId ?? null,
        },
        nowMs,
      )
    : null;
  const trialLapsed = isTrialRow && derivedTrialEndMs !== null && nowMs >= derivedTrialEndMs;
  const trialEndsAt =
    overrides.trialEndsAt ??
    (derivedTrialEndMs !== null ? new Date(derivedTrialEndMs).toISOString().slice(0, 10) : null);

  const planLimit = planUnknown ? null : maxPropertiesForManagerTier(tier);
  const cap = resolveManagerPropertyCap({ planLimit, capOverride: overrides.propertyCap });
  // Suppress a plan-derived cap we could not resolve, but keep a staff-pinned one: that number was
  // typed by a person and does not depend on the plan read.
  const propertyLimit = planUnknown && cap.source === "plan" ? null : cap.limit;

  const serviceFeePayer =
    planUnknown || tier === null
      ? // A legacy account with no purchase row resolves to `tier: null`, which the fee resolver has
        // no branch for; showing nothing is honest, showing "resident" would not be.
        null
      : resolveServiceFeePayerFor({
          tier,
          adminOverride: input.adminFeeOverride,
          managerChoice: input.managerFeeChoice,
          waiverGranted: isWaiverGrantedManagerPurchase(purchase?.promoCode ?? null),
        });

  const comms =
    input.commsUsedCents === null || planUnknown
      ? null
      : evaluateCommsAllowance({
          tier: normalizeCommsPlanTier(tier),
          usedCents: input.commsUsedCents,
          hasPaymentMethod: input.commsHasPaymentMethod,
        });

  return {
    id: input.id,
    email: input.email,
    fullName: input.fullName,
    managerId: input.managerId,
    active: input.active,
    joinedAt: input.joinedAt,
    storedTier: normalizeManagerSkuTier(purchase?.tier ?? null) ?? "free",
    tier,
    planUnknown,
    planLabel: planUnknown ? "Plan unknown" : tier === null ? "Legacy (uncapped)" : PLAN_LABELS[tier],
    onTrial: isTrialRow && !trialLapsed,
    trialLapsed,
    trialEndsAt,
    trialEndIsOverride: overrides.trialEndsAt !== null,
    propertyLimit,
    propertyLimitIsOverride: cap.source === "override",
    listedCount: input.listedCount,
    atPropertyLimit:
      propertyLimit !== null && input.listedCount !== null && input.listedCount >= propertyLimit,
    serviceFeePayer,
    proplaneAbsorbsFees: serviceFeePayer === "proplane",
    feeOverrideSetByStaff: input.adminFeeOverride !== null,
    complimentary: overrides.complimentary,
    comms,
  };
}

export const ADMIN_BILLING_TABS = [
  { id: "all", label: "All" },
  { id: "trial", label: "Trial" },
  { id: "free", label: "Free" },
  { id: "pro", label: "Pro" },
  { id: "business", label: "Business" },
  { id: "absorbing", label: "Absorbing fees" },
] as const;

export type AdminBillingTabId = (typeof ADMIN_BILLING_TABS)[number]["id"];

export function adminBillingTabFromParam(raw: string | null | undefined): AdminBillingTabId {
  const value = String(raw ?? "").trim().toLowerCase();
  return (ADMIN_BILLING_TABS as readonly { id: string }[]).some((tab) => tab.id === value)
    ? (value as AdminBillingTabId)
    : "all";
}

/**
 * Which tab a row belongs to.
 *
 * A row whose plan could not be read appears ONLY under All. Filing it under Free would be the
 * exact wrong guess, and inventing a sixth "unknown" plan tab would bury it — All is where staff
 * see the whole population, and the row says "Plan unknown" in place of a plan.
 */
export function adminBillingRowMatchesTab(row: AdminBillingRow, tab: AdminBillingTabId): boolean {
  if (tab === "all") return true;
  if (tab === "absorbing") return row.proplaneAbsorbsFees;
  if (row.planUnknown) return false;
  if (tab === "trial") return row.onTrial;
  return row.tier === tab;
}

export function adminBillingTabCounts(rows: AdminBillingRow[]): Record<AdminBillingTabId, number> {
  const counts = { all: 0, trial: 0, free: 0, pro: 0, business: 0, absorbing: 0 };
  for (const row of rows) {
    for (const tab of ADMIN_BILLING_TABS) {
      if (adminBillingRowMatchesTab(row, tab.id)) counts[tab.id] += 1;
    }
  }
  return counts;
}
