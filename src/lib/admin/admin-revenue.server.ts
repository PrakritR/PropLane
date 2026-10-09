import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  classifyBalanceTransaction,
  classifyCharge,
  EMPTY_CLASSIFY_CONTEXT,
  filterRevenueRows,
  isRevenueMonth,
  revenueTabCounts,
  shiftMonth,
  summarizeRevenue,
  type ClassifyContext,
  type InvoiceHint,
  type NormalizedBalanceTransaction,
  type RevenueAccountHint,
  type RevenueFilters,
  type RevenueRow,
  type RevenueSummary,
  type RevenueTabId,
} from "@/lib/admin/admin-revenue-model";
import { ADMIN_PROFILE_ID_CHUNK } from "@/lib/auth/admin-portal-manager-ids.server";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { pacificCalendarMonthKey, pacificStartOfDayMs } from "@/lib/pacific-time";
import { getStripe } from "@/lib/stripe";

/**
 * Money > Payments: a live read of PropLane's platform Stripe account, kept for
 * five minutes per month so a refresh storm on the page (or the Dashboard) never
 * becomes a Stripe rate-limit storm. Decision D2 of plan admin-money-1008: no
 * nightly sync table.
 *
 * Sources, all merged into one list of {@link RevenueRow}:
 *   1. Stripe balance transactions (charges, refunds, payouts), classified from
 *      metadata, invoice price ids and the customer's subscription.
 *   2. Apple subscriptions from `manager_purchases` (shown "via App Store"; Apple
 *      pays out separately and Stripe never sees them).
 *   3. The vendor service fee from `platform_revenue_entries` (the fee is held back
 *      from a vendor payment, so it is never a Stripe balance transaction of its own).
 *
 * A Stripe failure is a typed result, never a thrown error and never a zero:
 * the page shows "Couldn't reach Stripe" and the Dashboard omits its cards.
 */

export const REVENUE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Balance transactions read per month. A month past this is flagged `truncated`, never silently clipped. */
export const REVENUE_MAX_TRANSACTIONS = 1500;
const MAX_INVOICES = 1000;
const MAX_REFUND_LOOKUPS = 25;
const SUPABASE_CHUNK = ADMIN_PROFILE_ID_CHUNK;

export type NextPayout = {
  amountCents: number;
  /** ISO instant, or null for money that is available but has no payout scheduled. */
  arrivalDate: string | null;
  scheduled: boolean;
};

export type AdminRevenueMonth = {
  month: string;
  rows: RevenueRow[];
  summary: RevenueSummary;
  counts: Record<RevenueTabId, number>;
  truncated: boolean;
  /** The secret key is sk_test_. */
  testMode: boolean;
  nextPayout: NextPayout | null;
  generatedAt: string;
};

export type AdminRevenueResult =
  | { ok: true; data: AdminRevenueMonth }
  | { ok: false; reason: "stripe_unavailable" | "stripe_error" };

export type RevenueDeps = {
  stripe?: () => Stripe;
  now?: () => number;
};

export function isStripeTestMode(): boolean {
  return process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_") ?? false;
}

// ------------------------------------------------------------------- cache

const cache = new Map<string, { at: number; value: AdminRevenueMonth }>();
const inflight = new Map<string, Promise<AdminRevenueResult>>();

export function clearAdminRevenueCache(): void {
  cache.clear();
  inflight.clear();
}

// ------------------------------------------------------------ month window

export function revenueMonthWindow(month: string): { startMs: number; endMs: number } | null {
  if (!isRevenueMonth(month)) return null;
  const startMs = pacificStartOfDayMs(`${month}-01`);
  const endMs = pacificStartOfDayMs(`${shiftMonth(month, 1)}-01`);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

export function currentRevenueMonth(nowMs = Date.now()): string {
  return pacificCalendarMonthKey(nowMs);
}

// ------------------------------------------------------------ normalization

type Loose = Record<string, unknown>;

function idOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && typeof (value as Loose).id === "string") return (value as Loose).id as string;
  return null;
}

function stringMetadata(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Loose)) if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Reduce a Stripe balance transaction (source expanded) to what classification needs. Exported for tests. */
export function normalizeBalanceTransaction(bt: Stripe.BalanceTransaction): NormalizedBalanceTransaction {
  const source = (bt.source && typeof bt.source === "object" ? bt.source : null) as Loose | null;
  const object = typeof source?.object === "string" ? source.object : null;
  const base: NormalizedBalanceTransaction = {
    id: bt.id,
    type: bt.type,
    reportingCategory: bt.reporting_category,
    amount: bt.amount,
    fee: bt.fee,
    net: bt.net,
    currency: bt.currency,
    created: bt.created,
    description: bt.description ?? null,
    sourceKind: "other",
    sourceId: idOf(bt.source),
    metadata: {},
    customerId: null,
    email: null,
    paymentIntentId: null,
    chargeId: null,
    payout: null,
  };
  if (!source) return base;
  if (object === "charge") {
    const billing = source.billing_details as { email?: string | null } | undefined;
    return {
      ...base,
      sourceKind: "charge",
      metadata: stringMetadata(source.metadata),
      customerId: idOf(source.customer),
      email: billing?.email ?? (typeof source.receipt_email === "string" ? source.receipt_email : null),
      paymentIntentId: idOf(source.payment_intent),
      description: (typeof source.description === "string" && source.description) || base.description,
    };
  }
  if (object === "refund") {
    return {
      ...base,
      sourceKind: "refund",
      metadata: stringMetadata(source.metadata),
      chargeId: idOf(source.charge),
      paymentIntentId: idOf(source.payment_intent),
    };
  }
  if (object === "payout") {
    return {
      ...base,
      sourceKind: "payout",
      payout: {
        arrivalDate: typeof source.arrival_date === "number" ? source.arrival_date : null,
        bankLast4: null,
        status: typeof source.status === "string" ? source.status : null,
      },
    };
  }
  return base;
}

function normalizeCharge(charge: Stripe.Charge): NormalizedBalanceTransaction {
  return {
    id: `charge:${charge.id}`,
    type: "charge",
    reportingCategory: "charge",
    amount: charge.amount,
    fee: 0,
    net: charge.amount,
    currency: charge.currency,
    created: charge.created,
    description: charge.description ?? null,
    sourceKind: "charge",
    sourceId: charge.id,
    metadata: stringMetadata(charge.metadata),
    customerId: idOf(charge.customer),
    email: charge.billing_details?.email ?? charge.receipt_email ?? null,
    paymentIntentId: idOf(charge.payment_intent),
    chargeId: null,
    payout: null,
  };
}

// ------------------------------------------------------------ Supabase reads

async function chunked<T, R>(
  items: readonly T[],
  read: (chunk: T[]) => PromiseLike<{ data: R[] | null; error: unknown }>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += SUPABASE_CHUNK) {
    const { data, error } = await read(items.slice(i, i + SUPABASE_CHUNK));
    if (error) throw new Error("revenue account lookup failed");
    out.push(...(data ?? []));
  }
  return out;
}

type PurchaseHintRow = {
  user_id: string | null;
  email: string | null;
  full_name: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

async function loadAccountContext(
  db: SupabaseClient,
  bts: readonly NormalizedBalanceTransaction[],
): Promise<Pick<ClassifyContext, "accountByCustomerId" | "accountByUserId" | "subscriptionCustomerIds">> {
  const accountByCustomerId = new Map<string, RevenueAccountHint>();
  const accountByUserId = new Map<string, RevenueAccountHint>();
  const subscriptionCustomerIds = new Set<string>();

  const customerIds = [...new Set(bts.map((bt) => bt.customerId).filter((id): id is string => Boolean(id)))];
  const userIds = [
    ...new Set(bts.map((bt) => bt.metadata.manager_user_id).filter((id): id is string => Boolean(id))),
  ];

  try {
    if (customerIds.length) {
      const purchases = await chunked<string, PurchaseHintRow>(customerIds, (chunk) =>
        db
          .from("manager_purchases")
          .select("user_id, email, full_name, stripe_customer_id, stripe_subscription_id")
          .in("stripe_customer_id", chunk),
      );
      for (const p of purchases) {
        if (!p.stripe_customer_id) continue;
        if (p.stripe_subscription_id) subscriptionCustomerIds.add(p.stripe_customer_id);
        if (!accountByCustomerId.has(p.stripe_customer_id) || p.user_id) {
          accountByCustomerId.set(p.stripe_customer_id, {
            accountId: p.user_id,
            name: p.full_name?.trim() || null,
            email: p.email,
          });
        }
      }
      // A messaging-credit customer is not always the subscription's customer.
      const wallets = await chunked<string, { manager_user_id: string | null; stripe_customer_id: string | null }>(
        customerIds.filter((id) => !accountByCustomerId.has(id)),
        (chunk) =>
          db
            .from("manager_comms_billing_accounts")
            .select("manager_user_id, stripe_customer_id")
            .in("stripe_customer_id", chunk),
      );
      for (const w of wallets) {
        if (w.stripe_customer_id && w.manager_user_id) userIds.push(w.manager_user_id);
        if (w.stripe_customer_id && w.manager_user_id) {
          accountByCustomerId.set(w.stripe_customer_id, { accountId: w.manager_user_id, name: null, email: null });
        }
      }
    }
    const wantedProfiles = [
      ...new Set([...userIds, ...[...accountByCustomerId.values()].map((a) => a.accountId).filter((v): v is string => Boolean(v))]),
    ];
    if (wantedProfiles.length) {
      const profiles = await chunked<string, { id: string; email: string | null; full_name: string | null }>(
        wantedProfiles,
        (chunk) => db.from("profiles").select("id, email, full_name").in("id", chunk),
      );
      const byId = new Map(profiles.map((p) => [p.id, p]));
      for (const id of wantedProfiles) {
        const profile = byId.get(id);
        accountByUserId.set(id, {
          accountId: id,
          name: profile?.full_name?.trim() || null,
          email: profile?.email ?? null,
        });
      }
      for (const [customer, hint] of accountByCustomerId) {
        const profile = hint.accountId ? byId.get(hint.accountId) : undefined;
        if (profile) {
          accountByCustomerId.set(customer, {
            accountId: hint.accountId,
            name: hint.name || profile.full_name?.trim() || null,
            email: hint.email || profile.email,
          });
        }
      }
    }
  } catch (error) {
    // Rows still list, just without the account link.
    console.error("admin revenue: account lookup failed", error instanceof Error ? error.message : error);
  }
  return { accountByCustomerId, accountByUserId, subscriptionCustomerIds };
}

async function loadInvoiceHints(
  stripe: Stripe,
  startMs: number,
  endMs: number,
): Promise<Map<string, InvoiceHint>> {
  const hints = new Map<string, InvoiceHint>();
  try {
    const invoices = await stripe.invoices
      .list({
        created: { gte: Math.floor(startMs / 1000) - 3 * 86400, lt: Math.floor(endMs / 1000) },
        limit: 100,
        expand: ["data.payments"],
      })
      .autoPagingToArray({ limit: MAX_INVOICES });
    for (const invoice of invoices) {
      const priceIds: string[] = [];
      let lineDescription: string | null = null;
      for (const line of invoice.lines?.data ?? []) {
        lineDescription ??= line.description ?? null;
        const price = line.pricing?.price_details?.price;
        const priceId = idOf(price);
        if (priceId) priceIds.push(priceId);
      }
      const hint: InvoiceHint = {
        invoiceId: invoice.id ?? "",
        isSubscription: invoice.parent?.type === "subscription_details",
        priceIds,
        lineDescription,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      };
      for (const payment of invoice.payments?.data ?? []) {
        const pi = idOf(payment.payment?.payment_intent);
        if (pi) hints.set(pi, hint);
      }
    }
  } catch (error) {
    console.error("admin revenue: invoice read failed", error instanceof Error ? error.message : error);
  }
  return hints;
}

async function loadPayoutBank(stripe: Stripe, bts: readonly NormalizedBalanceTransaction[]): Promise<string | null> {
  const first = bts.find((bt) => bt.sourceKind === "payout" && bt.sourceId);
  if (!first?.sourceId) return null;
  try {
    const payout = await stripe.payouts.retrieve(first.sourceId, { expand: ["destination"] });
    const destination = payout.destination;
    if (destination && typeof destination === "object" && "last4" in destination) {
      return (destination as { last4?: string | null }).last4 ?? null;
    }
  } catch {
    // The payout rows still list; they just omit the bank.
  }
  return null;
}

async function loadNextPayout(stripe: Stripe): Promise<NextPayout | null> {
  try {
    const payouts = await stripe.payouts.list({ limit: 10 });
    const upcoming = payouts.data
      .filter((p) => p.status === "pending" || p.status === "in_transit")
      .sort((a, b) => a.arrival_date - b.arrival_date)[0];
    if (upcoming) {
      return {
        amountCents: upcoming.amount,
        arrivalDate: new Date(upcoming.arrival_date * 1000).toISOString(),
        scheduled: true,
      };
    }
    const balance = await stripe.balance.retrieve();
    const available = (balance.available ?? [])
      .filter((entry) => entry.currency === "usd")
      .reduce((sum, entry) => sum + entry.amount, 0);
    return available > 0 ? { amountCents: available, arrivalDate: null, scheduled: false } : null;
  } catch {
    return null;
  }
}

async function loadAppleRows(db: SupabaseClient, startMs: number, endMs: number): Promise<RevenueRow[]> {
  try {
    const { data, error } = await db
      .from("manager_purchases")
      .select("id, user_id, email, full_name, tier, billing, paid_at, apple_original_transaction_id, apple_environment")
      .not("apple_original_transaction_id", "is", null)
      .gte("paid_at", new Date(startMs).toISOString())
      .lt("paid_at", new Date(endMs).toISOString())
      .limit(2000);
    if (error) return [];
    const rows: RevenueRow[] = [];
    for (const p of (data ?? []) as {
      id: string;
      user_id: string | null;
      email: string | null;
      full_name: string | null;
      tier: string | null;
      billing: string | null;
      paid_at: string | null;
      apple_original_transaction_id: string | null;
      apple_environment: string | null;
    }[]) {
      const tier = String(p.tier ?? "").toLowerCase();
      if ((tier !== "pro" && tier !== "business") || !p.paid_at) continue;
      if (String(p.apple_environment ?? "").toLowerCase() === "sandbox") continue;
      const gross = RATE_CARD[tier].floorMonthlyCents;
      rows.push({
        id: `apple:${p.id}`,
        source: "app_store",
        category: "subscriptions",
        created: new Date(p.paid_at).toISOString(),
        title: `${tier === "pro" ? "Pro" : "Business"} - ${p.full_name?.trim() || p.email || "App Store subscriber"}`,
        email: p.email,
        accountId: p.user_id,
        accountName: p.full_name?.trim() || null,
        grossCents: gross,
        // Apple's commission is taken before payout and is not in our data.
        feeCents: 0,
        netCents: gross,
        currency: "usd",
        stripePath: null,
        payout: null,
        chargeId: null,
        invoiceId: null,
        hostedInvoiceUrl: null,
        stripeCustomerId: null,
        description: null,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

async function loadServiceFeeRows(db: SupabaseClient, startMs: number, endMs: number): Promise<RevenueRow[]> {
  try {
    const { data, error } = await db
      .from("platform_revenue_entries")
      .select("id, kind, amount_cents, manager_user_id, description, created_at")
      .gte("created_at", new Date(startMs).toISOString())
      .lt("created_at", new Date(endMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) return [];
    const entries = (data ?? []) as {
      id: string;
      kind: string;
      amount_cents: number;
      manager_user_id: string | null;
      description: string | null;
      created_at: string;
    }[];
    const managerIds = [...new Set(entries.map((e) => e.manager_user_id).filter((v): v is string => Boolean(v)))];
    const profiles = managerIds.length
      ? await chunked<string, { id: string; email: string | null; full_name: string | null }>(managerIds, (chunk) =>
          db.from("profiles").select("id, email, full_name").in("id", chunk),
        ).catch(() => [])
      : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return entries.map((entry) => {
      const profile = entry.manager_user_id ? byId.get(entry.manager_user_id) : undefined;
      const reversal = entry.kind === "vendor_service_fee_reversal";
      return {
        id: `fee:${entry.id}`,
        source: "ledger" as const,
        category: "service_fees" as const,
        created: new Date(entry.created_at).toISOString(),
        title: reversal ? "Vendor service fee reversed" : "Vendor service fee",
        email: profile?.email ?? null,
        accountId: entry.manager_user_id,
        accountName: profile?.full_name?.trim() || null,
        grossCents: entry.amount_cents,
        feeCents: 0,
        netCents: entry.amount_cents,
        currency: "usd",
        stripePath: null,
        payout: null,
        chargeId: null,
        invoiceId: null,
        hostedInvoiceUrl: null,
        stripeCustomerId: null,
        description: entry.description,
      };
    });
  } catch {
    return [];
  }
}

// -------------------------------------------------------------- the loader

async function buildMonth(db: SupabaseClient, month: string, deps: RevenueDeps): Promise<AdminRevenueResult> {
  const window = revenueMonthWindow(month);
  if (!window) return { ok: false, reason: "stripe_error" };
  const { startMs, endMs } = window;

  let stripe: Stripe;
  try {
    stripe = (deps.stripe ?? getStripe)();
  } catch {
    return { ok: false, reason: "stripe_unavailable" };
  }

  let normalized: NormalizedBalanceTransaction[];
  let truncated = false;
  try {
    const raw = await stripe.balanceTransactions
      .list({
        created: { gte: Math.floor(startMs / 1000), lt: Math.floor(endMs / 1000) },
        limit: 100,
        expand: ["data.source"],
      })
      .autoPagingToArray({ limit: REVENUE_MAX_TRANSACTIONS + 1 });
    truncated = raw.length > REVENUE_MAX_TRANSACTIONS;
    normalized = raw.slice(0, REVENUE_MAX_TRANSACTIONS).map(normalizeBalanceTransaction);
  } catch (error) {
    console.error("admin revenue: balance transactions failed", error instanceof Error ? error.message : error);
    return { ok: false, reason: "stripe_error" };
  }

  const [accounts, invoiceByPaymentIntent, bankLast4, nextPayout, appleRows, feeRows] = await Promise.all([
    loadAccountContext(db, normalized),
    loadInvoiceHints(stripe, startMs, endMs),
    loadPayoutBank(stripe, normalized),
    loadNextPayout(stripe),
    loadAppleRows(db, startMs, endMs),
    loadServiceFeeRows(db, startMs, endMs),
  ]);
  for (const bt of normalized) if (bt.payout) bt.payout.bankLast4 = bankLast4;

  const ctx: ClassifyContext = { ...EMPTY_CLASSIFY_CONTEXT, ...accounts, invoiceByPaymentIntent, chargeCategory: new Map() };

  // Charges first, so a refund can say what it refunded.
  const chargeCategory = new Map<string, { category: RevenueRow["category"]; title: string }>();
  const classified: RevenueRow[] = [];
  const refunds: NormalizedBalanceTransaction[] = [];
  for (const bt of normalized) {
    if (bt.sourceKind === "refund" || bt.type === "refund" || bt.type === "payment_refund") {
      refunds.push(bt);
      continue;
    }
    const row = classifyBalanceTransaction(bt, ctx);
    classified.push(row);
    if (bt.sourceKind === "charge" && bt.sourceId) chargeCategory.set(bt.sourceId, { category: row.category, title: row.title });
  }
  const missing = [...new Set(refunds.map((r) => r.chargeId).filter((id): id is string => Boolean(id)))].filter(
    (id) => !chargeCategory.has(id),
  );
  for (const chargeId of missing.slice(0, MAX_REFUND_LOOKUPS)) {
    try {
      const charge = normalizeCharge(await stripe.charges.retrieve(chargeId));
      const label =
        ctx.accountByCustomerId.get(charge.customerId ?? "")?.name ?? ctx.accountByCustomerId.get(charge.customerId ?? "")?.email;
      const hit = classifyCharge(charge, ctx, label ? ` - ${label}` : "");
      chargeCategory.set(chargeId, { category: hit.category, title: hit.title });
    } catch {
      // Unresolved: the refund falls to `other` rather than being counted as ours.
    }
  }
  const refundCtx: ClassifyContext = { ...ctx, chargeCategory };
  for (const bt of refunds) classified.push(classifyBalanceTransaction(bt, refundCtx));

  const rows = [...classified, ...appleRows, ...feeRows].sort((a, b) => b.created.localeCompare(a.created));
  const now = (deps.now ?? Date.now)();
  return {
    ok: true,
    data: {
      month,
      rows,
      summary: summarizeRevenue(rows),
      counts: revenueTabCounts(rows),
      truncated,
      testMode: isStripeTestMode(),
      nextPayout,
      generatedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * One month of platform revenue, cached for {@link REVENUE_CACHE_TTL_MS}. Concurrent callers share
 * one in-flight read. Failures are never cached, so the page's Retry really retries.
 */
export async function loadAdminRevenueMonth(
  db: SupabaseClient,
  month: string,
  deps: RevenueDeps = {},
): Promise<AdminRevenueResult> {
  const nowMs = (deps.now ?? Date.now)();
  const hit = cache.get(month);
  if (hit && nowMs - hit.at < REVENUE_CACHE_TTL_MS) return { ok: true, data: hit.value };
  const pending = inflight.get(month);
  if (pending) return pending;
  const run = buildMonth(db, month, deps)
    .then((result) => {
      if (result.ok) cache.set(month, { at: nowMs, value: result.data });
      return result;
    })
    .finally(() => inflight.delete(month));
  inflight.set(month, run);
  return run;
}

// ------------------------------------------------------------ list + detail

export const REVENUE_PAGE_SIZE_MAX = 100;

export type AdminRevenuePage = {
  month: string;
  rows: RevenueRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: RevenueSummary;
  counts: Record<RevenueTabId, number>;
  truncated: boolean;
  testMode: boolean;
  nextPayout: NextPayout | null;
  generatedAt: string;
};

export function pageRevenue(
  data: AdminRevenueMonth,
  filters: RevenueFilters,
  page: number,
  pageSize: number,
): AdminRevenuePage {
  const filtered = filterRevenueRows(data.rows, filters);
  const size = Math.min(Math.max(1, Math.floor(pageSize) || 50), REVENUE_PAGE_SIZE_MAX);
  const current = Math.max(1, Math.floor(page) || 1);
  return {
    month: data.month,
    rows: filtered.slice((current - 1) * size, current * size),
    total: filtered.length,
    page: current,
    pageSize: size,
    summary: data.summary,
    counts: data.counts,
    truncated: data.truncated,
    testMode: data.testMode,
    nextPayout: data.nextPayout,
    generatedAt: data.generatedAt,
  };
}

/** The Dashboard's revenue figures for the current month, or null when Stripe could not be read. */
export async function loadAdminMonthEarnings(
  db: SupabaseClient,
  deps: RevenueDeps = {},
): Promise<{ earnedCents: number; stripeFeesCents: number } | null> {
  const month = currentRevenueMonth((deps.now ?? Date.now)());
  const result = await loadAdminRevenueMonth(db, month, deps);
  if (!result.ok) return null;
  return { earnedCents: result.data.summary.earnedCents, stripeFeesCents: result.data.summary.stripeFeesCents };
}

/** One payment record, by row id. Reads the month the id's date falls in when it is known, else the current and prior month. */
export async function loadAdminRevenueRow(
  db: SupabaseClient,
  id: string,
  months: readonly string[],
  deps: RevenueDeps = {},
): Promise<{ ok: true; row: RevenueRow; testMode: boolean } | { ok: false; reason: "not_found" | "stripe_unavailable" | "stripe_error" }> {
  let failure: "stripe_unavailable" | "stripe_error" | null = null;
  for (const month of months) {
    const result = await loadAdminRevenueMonth(db, month, deps);
    if (!result.ok) {
      failure = result.reason;
      continue;
    }
    const row = result.data.rows.find((r) => r.id === id);
    if (row) return { ok: true, row, testMode: result.data.testMode };
  }
  return { ok: false, reason: failure ?? "not_found" };
}
