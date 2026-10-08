import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  classifySubscriber,
  filterSubscribers,
  subscriberCounts,
  subscriberMrrCents,
  type SubscriberCounts,
  type SubscriberFilters,
  type SubscriberPurchase,
  type SubscriberRow,
} from "@/lib/admin/admin-subscribers-model";
import {
  listAdminPortalManagerUserIds,
  loadProfilesByIdChunks,
  mapWithBoundedConcurrency,
  readAllPages,
} from "@/lib/auth/admin-portal-manager-ids.server";
import { listSandboxAccountIds } from "@/lib/admin/admin-accounts.server";
import { pickBestManagerPurchaseRow, type ManagerPurchaseRowRecord } from "@/lib/manager-access";
import { EMPTY_MANAGER_BILLING_OVERRIDES, type ManagerBillingOverrides } from "@/lib/manager-billing-overrides";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { getStripe } from "@/lib/stripe";

/**
 * The Subscribers population: every real (non-sandbox) manager, classified by
 * `classifySubscriber`. All reads are paged (`readAllPages`: stable order, a failed
 * page throws) or id-chunked; nothing is an unbounded select. The Stripe period end
 * is looked up for the visible page only.
 */

type PurchaseRow = {
  id: string;
  user_id: string | null;
  email: string | null;
  tier: string | null;
  billing: string | null;
  paid_at: string | null;
  promo_code: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  apple_original_transaction_id: string | null;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  created_at: string | null;
};

export type SubscriberPopulation = {
  rows: SubscriberRow[];
  /** Managers whose plan could not be read. They are in no tab and no count. */
  unreadable: number;
};

const PURCHASE_SELECT =
  "id, user_id, email, tier, billing, paid_at, promo_code, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id, apple_original_transaction_id";

async function loadOverrides(db: SupabaseClient): Promise<Map<string, ManagerBillingOverrides>> {
  const out = new Map<string, ManagerBillingOverrides>();
  try {
    const rows = await readAllPages<{ manager_user_id: string; comp: unknown; trial: unknown }>((from, to) =>
      db
        .from("manager_automation_settings")
        .select(
          "manager_user_id, comp:row_data->billingOverrides->>complimentary, trial:row_data->billingOverrides->>trialEndsAt",
        )
        .order("manager_user_id")
        .range(from, to),
    );
    for (const row of rows) {
      const complimentary = row.comp === true || row.comp === "true";
      const trial = typeof row.trial === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.trial) ? row.trial : null;
      if (!complimentary && !trial) continue;
      out.set(String(row.manager_user_id), { ...EMPTY_MANAGER_BILLING_OVERRIDES, complimentary, trialEndsAt: trial });
    }
  } catch (error) {
    // An unreadable override must not read as "no override": say so through the caller.
    throw new Error(`overrides: ${error instanceof Error ? error.message : "read failed"}`);
  }
  return out;
}

export async function loadSubscriberPopulation(db: SupabaseClient, nowMs = Date.now()): Promise<SubscriberPopulation> {
  const [allIds, sandboxIds] = await Promise.all([listAdminPortalManagerUserIds(db), listSandboxAccountIds(db)]);
  const ids = allIds.filter((id) => !sandboxIds.has(id));
  const [profiles, purchases, overrides] = await Promise.all([
    loadProfilesByIdChunks<ProfileRow>(db, ids, "id, email, full_name, created_at"),
    readAllPages<PurchaseRow>((from, to) =>
      db.from("manager_purchases").select(PURCHASE_SELECT).order("id").range(from, to),
    ),
    loadOverrides(db),
  ]);

  const byUser = new Map<string, PurchaseRow[]>();
  const byEmail = new Map<string, PurchaseRow[]>();
  for (const purchase of purchases) {
    if (purchase.user_id) byUser.set(purchase.user_id, [...(byUser.get(purchase.user_id) ?? []), purchase]);
    const email = String(purchase.email ?? "").trim().toLowerCase();
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), purchase]);
  }

  const rows: SubscriberRow[] = [];
  let unreadable = 0;
  for (const profile of profiles) {
    const email = String(profile.email ?? "").trim().toLowerCase();
    if (isPortalSandboxEmail(email)) continue;
    // Same merge the plan resolver makes: rows tied to the user id AND rows tied only by email.
    const candidates = new Map<string, ManagerPurchaseRowRecord & PurchaseRow>();
    for (const p of [...(byUser.get(profile.id) ?? []), ...(email ? (byEmail.get(email) ?? []) : [])]) {
      candidates.set(String(p.id), { ...p, id: String(p.id) });
    }
    const best = pickBestManagerPurchaseRow([...candidates.values()], profile.id) as PurchaseRow | null;
    const purchase: SubscriberPurchase | null = best
      ? {
          tier: best.tier,
          billing: best.billing,
          paidAt: best.paid_at,
          promoCode: best.promo_code,
          stripeSubscriptionId: best.stripe_subscription_id,
          stripeCustomerId: best.stripe_customer_id,
          stripeCheckoutSessionId: best.stripe_checkout_session_id,
          appleOriginalTransactionId: best.apple_original_transaction_id,
        }
      : null;
    const row = classifySubscriber({
      id: profile.id,
      email: profile.email ?? "",
      fullName: profile.full_name?.trim() ?? "",
      joinedAt: profile.created_at,
      purchase,
      planReadFailed: false,
      overrides: overrides.get(profile.id) ?? EMPTY_MANAGER_BILLING_OVERRIDES,
      nowMs,
    });
    if (row) rows.push(row);
    else unreadable += 1;
  }
  return { rows, unreadable };
}

/** Stripe's current period end for one subscription, as an ISO date; null when it cannot be read. */
async function renewalOf(stripe: Stripe, subscriptionId: string): Promise<string | null> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (sub.status === "canceled") return null;
    const end = sub.items?.data?.[0]?.current_period_end;
    return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** Fill `renewsAt` on the visible rows from Stripe. Never throws; a miss leaves the fact out. */
export async function enrichRenewals(
  rows: SubscriberRow[],
  deps: { stripe?: () => Stripe } = {},
): Promise<SubscriberRow[]> {
  const wanted = rows.filter((row) => row.stripeSubscriptionId && row.bucket !== "trial");
  if (wanted.length === 0) return rows;
  let stripe: Stripe;
  try {
    stripe = (deps.stripe ?? getStripe)();
  } catch {
    return rows;
  }
  const renewals = await mapWithBoundedConcurrency(wanted, 6, (row) => renewalOf(stripe, row.stripeSubscriptionId!));
  const byId = new Map(wanted.map((row, index) => [row.id, renewals[index]!]));
  return rows.map((row) => (byId.has(row.id) ? { ...row, renewsAt: byId.get(row.id) ?? null } : row));
}

export type AdminSubscribersPage = {
  rows: SubscriberRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: SubscriberCounts;
  mrrCents: number;
  unreadable: number;
};

export const SUBSCRIBERS_PAGE_SIZE_MAX = 100;

export function pageSubscribers(
  population: SubscriberPopulation,
  filters: SubscriberFilters,
  page: number,
  pageSize: number,
): AdminSubscribersPage {
  const filtered = filterSubscribers(population.rows, filters);
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 50), SUBSCRIBERS_PAGE_SIZE_MAX);
  const current = Math.max(1, Math.floor(page) || 1);
  return {
    rows: filtered.slice((current - 1) * size, current * size),
    total: filtered.length,
    page: current,
    pageSize: size,
    counts: subscriberCounts(population.rows),
    mrrCents: subscriberMrrCents(population.rows),
    unreadable: population.unreadable,
  };
}

/** The Dashboard's subscriber figures, or null when the population could not be read. */
export async function loadAdminSubscriberFigures(
  db: SupabaseClient,
  nowMs = Date.now(),
): Promise<{ counts: SubscriberCounts; mrrCents: number } | null> {
  try {
    const population = await loadSubscriberPopulation(db, nowMs);
    return { counts: subscriberCounts(population.rows), mrrCents: subscriberMrrCents(population.rows) };
  } catch (error) {
    console.error("admin subscribers: population read failed", error instanceof Error ? error.message : error);
    return null;
  }
}
