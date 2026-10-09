import type { ManagerSkuTier } from "@/lib/manager-access";

/**
 * The client-safe half of the Subscribers model: tab ids, row shape and the display predicates the
 * panel needs. The classifier itself (`admin-subscribers-model.ts`) imports the plan resolvers, one
 * of which is server-only, so the panel imports only this file.
 */

export const SUBSCRIBER_TABS = [
  { id: "paid", label: "Paid" },
  { id: "trial", label: "Trial" },
  { id: "promo", label: "Promo" },
  { id: "free", label: "Free" },
  { id: "complimentary", label: "Complimentary" },
] as const;

export type SubscriberBucket = (typeof SUBSCRIBER_TABS)[number]["id"];

export function subscriberTabFromParam(raw: string | null | undefined): SubscriberBucket {
  const value = String(raw ?? "").trim().toLowerCase();
  return SUBSCRIBER_TABS.some((tab) => tab.id === value) ? (value as SubscriberBucket) : "paid";
}

export type SubscriberSource = "stripe" | "app_store" | "proplane";

export type SubscriberRow = {
  id: string;
  /** `manager-<id>`, the account record's URL segment. */
  accountKey: string;
  email: string;
  name: string;
  bucket: SubscriberBucket;
  tier: ManagerSkuTier | null;
  /** "Pro monthly", "Business annual", "Pro trial", "Free". */
  planLabel: string;
  source: SubscriberSource;
  /** ISO. When the account started on this plan (purchase date, else sign-up). */
  since: string | null;
  /** `YYYY-MM-DD`. Set for a live trial. */
  trialEndsAt: string | null;
  /** Calendar days from today until the trial ends (0 = today); null outside a trial. */
  trialDaysLeft: number | null;
  promoCode: string | null;
  /** Monthly figure in cents at list price. Null when the account pays nothing. */
  monthlyCents: number | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  /** Stripe's current period end, filled in from Stripe for the visible page only. */
  renewsAt: string | null;
};

export type SubscriberCounts = Record<SubscriberBucket, number>;

/** A trial inside its last three days draws amber text (never a pill). */
export function trialEndsSoon(row: Pick<SubscriberRow, "trialDaysLeft">): boolean {
  return row.trialDaysLeft !== null && row.trialDaysLeft <= 3;
}
