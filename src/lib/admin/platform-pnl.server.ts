import "server-only";

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
import { NUMBER_SUBSCRIPTION_PURPOSE } from "@/lib/number-subscription/constants";
import { pacificCalendarMonthKey } from "@/lib/pacific-time";
import {
  computeMonthlyPnl,
  emptyStreams,
  expenseTotalsByMonth,
  monthsEndingAt,
  type MonthlyPnl,
  type RevenueStreams,
} from "@/lib/admin/platform-expense-rules";
import { listPlatformExpenses } from "@/lib/admin/platform-expenses.server";

/**
 * PropLane's own profit and loss: revenue by stream and Stripe's fees from the platform balance, then
 * the hand-entered expenses.
 *
 * TODO(admin-money-1008): `loadMonthlyPlatformRevenue` reads Stripe balance transactions directly
 * because the shared revenue helper (src/lib/admin/admin-revenue.server.ts, owned by the Payments
 * builder) did not exist when Finances was built. Once it lands, both pages should read one source;
 * until then the streams below are this file's own grouping.
 *
 * What counts as revenue (a Stripe balance transaction on PropLane's own account, USD):
 *   subscriptions  a paid invoice that is not a number subscription (manager plans and add-ons)
 *   numbers        a paid invoice whose subscription carries the PropLane Number purpose
 *   credits        a charge whose metadata purpose is the messaging credit pack
 *   serviceFees    an application fee (the vendor service fee taken on connected accounts)
 * Refunds and disputes subtract. Resident processing fees are not revenue (they cover Stripe's own
 * cost), and a charge that matches no stream is reported as `unclassifiedCents` instead of guessed
 * into one. Apple (RevenueCat) income is paid out separately and is not on this balance.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const INVOICE_LOOKBACK_SECONDS = 35 * 24 * 60 * 60;
const MAX_BALANCE_TRANSACTIONS = 10_000;
const MAX_INVOICES = 5_000;

export type PlatformRevenueMonth = {
  month: string;
  streams: RevenueStreams;
  /** Refunds and lost disputes, positive. */
  refundsCents: number;
  stripeFeesCents: number;
  unclassifiedCents: number;
};

type ChargeKind = "subscriptions" | "numbers";

type BalanceTransactionLike = {
  id: string;
  amount: number;
  fee: number;
  currency: string;
  created: number;
  type: string;
  reporting_category?: string | null;
  source?: string | { id?: string; object?: string; payment_intent?: unknown; metadata?: Record<string, string> | null } | null;
};

function emptyMonth(month: string): PlatformRevenueMonth {
  return { month, streams: emptyStreams(), refundsCents: 0, stripeFeesCents: 0, unclassifiedCents: 0 };
}

function idOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

const REFUND_CATEGORIES = new Set(["refund", "dispute", "dispute_reversal"]);
const REFUND_TYPES = new Set(["refund", "payment_refund", "refund_failure", "payment_failure_refund"]);
const CHARGE_TYPES = new Set(["charge", "payment"]);
const FEE_TYPES = new Set(["stripe_fee", "network_cost"]);

/**
 * Folds balance transactions into per-month revenue. Pure: `chargeKinds` maps a Stripe charge id or
 * payment intent id to the kind of invoice that paid it, and `months` limits which months are kept.
 */
export function groupBalanceTransactions(
  transactions: readonly BalanceTransactionLike[],
  chargeKinds: ReadonlyMap<string, ChargeKind>,
  months: readonly string[],
): Map<string, PlatformRevenueMonth> {
  const out = new Map(months.map((month) => [month, emptyMonth(month)] as const));

  for (const bt of transactions) {
    if (bt.currency !== "usd") continue;
    const entry = out.get(pacificCalendarMonthKey(bt.created * 1000));
    if (!entry) continue;
    const category = bt.reporting_category ?? bt.type;

    if (bt.type === "application_fee" || category === "platform_earning") {
      entry.streams.serviceFees += bt.amount;
      entry.stripeFeesCents += bt.fee;
    } else if (bt.type === "application_fee_refund" || category === "platform_earning_refund") {
      entry.streams.serviceFees += bt.amount;
    } else if (CHARGE_TYPES.has(bt.type) || category === "charge") {
      entry.stripeFeesCents += bt.fee;
      const source = bt.source && typeof bt.source !== "string" ? bt.source : null;
      if (source?.metadata?.purpose === COMMS_CREDIT_PURPOSE) {
        entry.streams.credits += bt.amount;
        continue;
      }
      const kind =
        chargeKinds.get(idOf(bt.source) ?? "") ?? chargeKinds.get(idOf(source?.payment_intent) ?? "");
      if (kind) entry.streams[kind] += bt.amount;
      else entry.unclassifiedCents += bt.amount;
    } else if (REFUND_CATEGORIES.has(category) || REFUND_TYPES.has(bt.type)) {
      entry.refundsCents += -bt.amount;
      entry.stripeFeesCents += bt.fee;
    } else if (FEE_TYPES.has(bt.type) || category === "fee") {
      entry.stripeFeesCents += -bt.amount;
    }
  }
  return out;
}

type InvoiceLike = {
  parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
  payments?: { data?: Array<{ payment?: { charge?: unknown; payment_intent?: unknown } | null }> } | null;
};

/** Charge and payment-intent ids of every paid invoice, labelled by what the invoice was for. */
export function indexInvoiceCharges(invoices: readonly InvoiceLike[]): Map<string, ChargeKind> {
  const kinds = new Map<string, ChargeKind>();
  for (const invoice of invoices) {
    const purpose = invoice.parent?.subscription_details?.metadata?.purpose;
    const kind: ChargeKind = purpose === NUMBER_SUBSCRIPTION_PURPOSE ? "numbers" : "subscriptions";
    for (const row of invoice.payments?.data ?? []) {
      for (const id of [idOf(row.payment?.charge), idOf(row.payment?.payment_intent)]) {
        if (id) kinds.set(id, kind);
      }
    }
  }
  return kinds;
}

let cache: { key: string; at: number; value: Map<string, PlatformRevenueMonth> } | null = null;

/** Clears the five-minute revenue cache (tests). */
export function clearPlatformRevenueCache(): void {
  cache = null;
}

function windowStartSeconds(firstMonth: string): number {
  // A day of slack before the 1st: Pacific midnight is 07:00 or 08:00 UTC, and the month filter is exact.
  return Math.floor(Date.parse(`${firstMonth}-01T00:00:00Z`) / 1000) - 24 * 60 * 60;
}

/** One Stripe pass over `months` (consecutive, oldest first), grouped per month. Cached for five minutes. */
export async function loadPlatformRevenueSeries(
  months: readonly string[],
  deps: { stripe?: Stripe } = {},
): Promise<Map<string, PlatformRevenueMonth>> {
  const key = months.join(",");
  if (!deps.stripe && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (months.length === 0) return new Map();

  const stripe = deps.stripe ?? getStripe();
  const gte = windowStartSeconds(months[0]!);

  const invoices = await stripe.invoices
    .list({ status: "paid", created: { gte: gte - INVOICE_LOOKBACK_SECONDS }, limit: 100, expand: ["data.payments"] })
    .autoPagingToArray({ limit: MAX_INVOICES });
  const transactions = await stripe.balanceTransactions
    .list({ created: { gte }, limit: 100, expand: ["data.source"] })
    .autoPagingToArray({ limit: MAX_BALANCE_TRANSACTIONS });

  const value = groupBalanceTransactions(
    transactions as unknown as BalanceTransactionLike[],
    indexInvoiceCharges(invoices as unknown as InvoiceLike[]),
    months,
  );
  if (!deps.stripe) cache = { key, at: Date.now(), value };
  return value;
}

/** Revenue by stream, refunds, and Stripe fees for one Pacific month (`YYYY-MM`). */
export async function loadMonthlyPlatformRevenue(
  month: string,
  deps: { stripe?: Stripe } = {},
): Promise<PlatformRevenueMonth> {
  const series = await loadPlatformRevenueSeries([month], deps);
  return series.get(month) ?? emptyMonth(month);
}

export type PlatformPnl = {
  /** The current Pacific month; the last of `months`. */
  currentMonth: string;
  /** Twelve months, oldest first. */
  months: MonthlyPnl[];
  /** False when Stripe could not be read: revenue, fees and profit are then unknown, not zero. */
  revenueAvailable: boolean;
  testMode: boolean;
};

/** The twelve-month P&L: Stripe revenue and fees where readable, plus the expense table. */
export async function loadPlatformPnl(
  deps: { stripe?: Stripe; now?: number; expenses?: typeof listPlatformExpenses } = {},
): Promise<PlatformPnl> {
  const currentMonth = pacificCalendarMonthKey(deps.now ?? Date.now());
  const months = monthsEndingAt(currentMonth, 12);
  const expenses = await (deps.expenses ?? listPlatformExpenses)({ from: months[0]!, to: currentMonth });
  const expenseTotals = expenseTotalsByMonth(expenses, months);

  let revenue: Map<string, PlatformRevenueMonth> | null = null;
  try {
    revenue = await loadPlatformRevenueSeries(months, deps.stripe ? { stripe: deps.stripe } : {});
  } catch (error) {
    // The message names Stripe request ids; log it and let the page show "Couldn't reach Stripe".
    console.error("platform revenue read failed", error);
  }

  return {
    currentMonth,
    months: months.map((month) => {
      const r = revenue?.get(month);
      return computeMonthlyPnl({
        month,
        streams: r?.streams ?? emptyStreams(),
        refundsCents: r?.refundsCents ?? 0,
        stripeFeesCents: r?.stripeFeesCents ?? 0,
        unclassifiedCents: r?.unclassifiedCents ?? 0,
        expensesCents: expenseTotals.get(month) ?? 0,
      });
    }),
    revenueAvailable: revenue !== null,
    testMode: process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_") ?? false,
  };
}
