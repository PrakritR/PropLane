/**
 * Pure model for the admin Payments page (Money > Payments): how one Stripe
 * balance transaction becomes a row, which tab it belongs to, what the stat
 * strip adds up, and the CSV a staff member downloads. No I/O, no Stripe SDK
 * value imports - `admin-revenue.server.ts` normalizes Stripe objects into
 * {@link NormalizedBalanceTransaction} and everything below is deterministic and
 * unit-tested with Stripe mocked.
 *
 * Revenue is what PropLane itself earns, and the platform Stripe account also
 * carries pass-through money (resident rent, vendor payments). A charge that
 * cannot be attributed to a PropLane product is `other`: it is listed under All
 * so staff can see it, and never added to gross, fees or refunds.
 */
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
import {
  NUMBER_CREDIT_PURPOSE,
  NUMBER_SUBSCRIPTION_PRODUCT_NAME,
  NUMBER_SUBSCRIPTION_PURPOSE,
} from "@/lib/number-subscription/constants";
import { inferBillingFromStripePriceId, inferPaidTierFromStripePriceId } from "@/lib/stripe-price-ids";

export type RevenueCategory =
  | "subscriptions"
  | "credits"
  | "numbers"
  | "service_fees"
  | "payouts"
  | "refunds"
  | "other";

/** The tabs, in the order the page draws them. `all` is not a category. */
export const REVENUE_TABS = [
  { id: "all", label: "All" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "credits", label: "Credits" },
  { id: "numbers", label: "Numbers" },
  { id: "service_fees", label: "Service fees" },
  { id: "payouts", label: "Payouts" },
  { id: "refunds", label: "Refunds" },
] as const;

export type RevenueTabId = (typeof REVENUE_TABS)[number]["id"];

export function revenueTabFromParam(raw: string | null | undefined): RevenueTabId {
  const value = String(raw ?? "").trim().toLowerCase();
  return REVENUE_TABS.some((tab) => tab.id === value) ? (value as RevenueTabId) : "all";
}

/** Categories that are PropLane's own earnings (what gross, fees and refunds add up). */
export const REVENUE_EARNING_CATEGORIES: readonly RevenueCategory[] = [
  "subscriptions",
  "credits",
  "numbers",
  "service_fees",
];

export type RevenueRowSource = "stripe" | "app_store" | "ledger";

export type RevenueRow = {
  /** `txn_...` for Stripe, `apple:<purchase id>` for App Store, `fee:<entry id>` for the vendor-fee ledger. */
  id: string;
  source: RevenueRowSource;
  category: RevenueCategory;
  /** ISO instant. */
  created: string;
  title: string;
  email: string | null;
  /** Manager user id when the row links to a PropLane account. */
  accountId: string | null;
  accountName: string | null;
  /** Positive for money in, negative for a refund or payout. */
  grossCents: number;
  /** Stripe's fee, always >= 0. */
  feeCents: number;
  netCents: number;
  currency: string;
  /** Dashboard path under /payments, /subscriptions... for "Open in Stripe"; null when there is no Stripe object. */
  stripePath: string | null;
  /** Payout rows. */
  payout: { arrivalDate: string | null; bankLast4: string | null; status: string | null } | null;
  /** A refund row's original charge id, when known. */
  chargeId: string | null;
  /** Free-form facts the record page shows (plan, invoice, receipt). */
  invoiceId: string | null;
  hostedInvoiceUrl: string | null;
  stripeCustomerId: string | null;
  description: string | null;
};

/** What `admin-revenue.server.ts` reduces a balance transaction (and its expanded source) to. */
export type NormalizedBalanceTransaction = {
  id: string;
  type: string;
  reportingCategory: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  /** Unix seconds. */
  created: number;
  description: string | null;
  sourceKind: "charge" | "refund" | "payout" | "other";
  sourceId: string | null;
  metadata: Record<string, string>;
  customerId: string | null;
  email: string | null;
  paymentIntentId: string | null;
  /** A refund's original charge. */
  chargeId: string | null;
  payout: { arrivalDate: number | null; bankLast4: string | null; status: string | null } | null;
};

export type InvoiceHint = {
  invoiceId: string;
  isSubscription: boolean;
  priceIds: string[];
  /** First line description, used when no price id maps to a plan. */
  lineDescription: string | null;
  hostedInvoiceUrl: string | null;
};

export type RevenueAccountHint = { accountId: string | null; name: string | null; email: string | null };

export type ClassifyContext = {
  /** Invoice facts by PaymentIntent id (what makes a charge a subscription charge). */
  invoiceByPaymentIntent: ReadonlyMap<string, InvoiceHint>;
  /** Stripe customers that hold a PropLane subscription (manager_purchases.stripe_subscription_id). */
  subscriptionCustomerIds: ReadonlySet<string>;
  /** PropLane account by Stripe customer id (manager_purchases.stripe_customer_id and friends). */
  accountByCustomerId: ReadonlyMap<string, RevenueAccountHint>;
  /** PropLane account by manager user id, for metadata-linked rows (credit packs). */
  accountByUserId: ReadonlyMap<string, RevenueAccountHint>;
  /** What a refund's original charge was, once resolved. */
  chargeCategory: ReadonlyMap<string, { category: RevenueCategory; title: string }>;
};

export const EMPTY_CLASSIFY_CONTEXT: ClassifyContext = {
  invoiceByPaymentIntent: new Map(),
  subscriptionCustomerIds: new Set(),
  accountByCustomerId: new Map(),
  accountByUserId: new Map(),
  chargeCategory: new Map(),
};

const PAYOUT_TYPES = new Set(["payout", "payout_cancel", "payout_failure"]);
const REFUND_TYPES = new Set(["refund", "payment_refund", "payment_failure_refund"]);
const CHARGE_TYPES = new Set(["charge", "payment"]);

const TIER_LABEL: Record<string, string> = { pro: "Pro", business: "Business" };

/** "Pro monthly" from the price ids on an invoice, or null when none maps to a plan. */
export function planLabelFromPriceIds(priceIds: readonly string[]): string | null {
  for (const priceId of priceIds) {
    const tier = inferPaidTierFromStripePriceId(priceId);
    if (!tier) continue;
    const billing = inferBillingFromStripePriceId(priceId);
    return billing ? `${TIER_LABEL[tier]} ${billing}` : TIER_LABEL[tier];
  }
  return null;
}

function accountFor(bt: NormalizedBalanceTransaction, ctx: ClassifyContext): RevenueAccountHint {
  const fromUser = bt.metadata.manager_user_id ? ctx.accountByUserId.get(bt.metadata.manager_user_id) : undefined;
  if (fromUser) return fromUser;
  const fromCustomer = bt.customerId ? ctx.accountByCustomerId.get(bt.customerId) : undefined;
  if (fromCustomer) return fromCustomer;
  return { accountId: null, name: null, email: bt.email };
}

function metadataPurpose(metadata: Record<string, string>): string {
  return String(metadata.purpose ?? "").trim();
}

/** The category and title of one CHARGE balance transaction. Exported so a refund can reuse it. */
export function classifyCharge(
  bt: NormalizedBalanceTransaction,
  ctx: ClassifyContext,
  accountLabel: string,
): { category: RevenueCategory; title: string; invoice: InvoiceHint | null } {
  const purpose = metadataPurpose(bt.metadata);
  if (purpose === COMMS_CREDIT_PURPOSE || purpose === NUMBER_CREDIT_PURPOSE) {
    return { category: "credits", title: `Messaging credit${accountLabel}`, invoice: null };
  }
  const invoice = bt.paymentIntentId ? (ctx.invoiceByPaymentIntent.get(bt.paymentIntentId) ?? null) : null;
  const numberHint =
    purpose === NUMBER_SUBSCRIPTION_PURPOSE ||
    bt.metadata.proplane_product === "number" ||
    /propLane number/i.test(bt.description ?? "") ||
    /propLane number/i.test(invoice?.lineDescription ?? "");
  if (numberHint) {
    return { category: "numbers", title: `${NUMBER_SUBSCRIPTION_PRODUCT_NAME}${accountLabel}`, invoice };
  }
  if (invoice?.isSubscription) {
    const plan = planLabelFromPriceIds(invoice.priceIds) ?? invoice.lineDescription ?? "Subscription";
    return { category: "subscriptions", title: `${plan}${accountLabel}`, invoice };
  }
  // No invoice read: a charge from a customer who holds a PropLane subscription, with no other
  // purpose on it, is that subscription's invoice.
  if (!purpose && bt.customerId && ctx.subscriptionCustomerIds.has(bt.customerId)) {
    return { category: "subscriptions", title: `Subscription${accountLabel}`, invoice };
  }
  return {
    category: "other",
    title: `${bt.description?.trim() || "Payment"}${accountLabel}`,
    invoice,
  };
}

function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Turn one normalized balance transaction into a row. Pure. */
export function classifyBalanceTransaction(bt: NormalizedBalanceTransaction, ctx: ClassifyContext): RevenueRow {
  const account = accountFor(bt, ctx);
  const accountLabel = account.name || account.email ? ` - ${account.name || account.email}` : "";
  const base = {
    id: bt.id,
    source: "stripe" as const,
    created: unixToIso(bt.created),
    email: account.email ?? bt.email,
    accountId: account.accountId,
    accountName: account.name,
    currency: bt.currency,
    stripePath: null as string | null,
    payout: null as RevenueRow["payout"],
    chargeId: null as string | null,
    invoiceId: null as string | null,
    hostedInvoiceUrl: null as string | null,
    stripeCustomerId: bt.customerId,
    description: bt.description,
  };

  if (PAYOUT_TYPES.has(bt.type) || bt.reportingCategory === "payout") {
    return {
      ...base,
      category: "payouts",
      title: bt.payout?.bankLast4 ? `Payout to bank ****${bt.payout.bankLast4}` : "Payout to bank",
      grossCents: bt.amount,
      feeCents: Math.max(0, bt.fee),
      netCents: bt.net,
      stripePath: bt.sourceId ? `payouts/${bt.sourceId}` : null,
      payout: {
        arrivalDate: bt.payout?.arrivalDate ? unixToIso(bt.payout.arrivalDate) : null,
        bankLast4: bt.payout?.bankLast4 ?? null,
        status: bt.payout?.status ?? null,
      },
    };
  }

  if (REFUND_TYPES.has(bt.type) || bt.reportingCategory === "refund") {
    const original = bt.chargeId ? ctx.chargeCategory.get(bt.chargeId) : undefined;
    // A refund of money that was never PropLane's (a resident's rent) is not a PropLane refund.
    const ours = original ? original.category !== "other" : false;
    return {
      ...base,
      category: ours ? "refunds" : "other",
      title: original ? `Refund - ${original.title}` : `Refund${accountLabel}`,
      grossCents: bt.amount,
      feeCents: Math.max(0, bt.fee),
      netCents: bt.net,
      chargeId: bt.chargeId,
      stripePath: bt.chargeId ? `payments/${bt.chargeId}` : null,
    };
  }

  if (CHARGE_TYPES.has(bt.type) || bt.reportingCategory === "charge") {
    const hit = classifyCharge(bt, ctx, accountLabel);
    return {
      ...base,
      category: hit.category,
      title: hit.title,
      grossCents: bt.amount,
      feeCents: Math.max(0, bt.fee),
      netCents: bt.net,
      stripePath: bt.sourceId ? `payments/${bt.sourceId}` : null,
      invoiceId: hit.invoice?.invoiceId ?? null,
      hostedInvoiceUrl: hit.invoice?.hostedInvoiceUrl ?? null,
    };
  }

  return {
    ...base,
    category: "other",
    title: bt.description?.trim() || bt.type.replace(/_/g, " "),
    grossCents: bt.amount,
    feeCents: Math.max(0, bt.fee),
    netCents: bt.net,
  };
}

// ---------------------------------------------------------------- stat strip

export type RevenueSummary = {
  /** Charges in the PropLane revenue categories. */
  grossCents: number;
  stripeFeesCents: number;
  /** Money handed back, as a positive number. */
  refundsCents: number;
  /** gross - refunds - Stripe fees. */
  netCents: number;
  /** gross - refunds: what the Dashboard calls "Earned". */
  earnedCents: number;
  /** Earned, split by category. */
  byCategory: Record<"subscriptions" | "credits" | "numbers" | "service_fees", number>;
};

/** What the stat strip adds up. `other` and payouts never count. */
export function summarizeRevenue(rows: readonly RevenueRow[]): RevenueSummary {
  let gross = 0;
  let fees = 0;
  let refunds = 0;
  const byCategory = { subscriptions: 0, credits: 0, numbers: 0, service_fees: 0 };
  for (const row of rows) {
    if (row.category === "refunds") {
      refunds += Math.abs(row.grossCents);
      continue;
    }
    if (!REVENUE_EARNING_CATEGORIES.includes(row.category)) continue;
    gross += row.grossCents;
    fees += row.feeCents;
    byCategory[row.category as keyof typeof byCategory] += row.grossCents;
  }
  return {
    grossCents: gross,
    stripeFeesCents: fees,
    refundsCents: refunds,
    netCents: gross - refunds - fees,
    earnedCents: gross - refunds,
    byCategory,
  };
}

export function revenueTabCounts(rows: readonly RevenueRow[]): Record<RevenueTabId, number> {
  const counts: Record<RevenueTabId, number> = {
    all: rows.length,
    subscriptions: 0,
    credits: 0,
    numbers: 0,
    service_fees: 0,
    payouts: 0,
    refunds: 0,
  };
  for (const row of rows) {
    if (row.category !== "other") counts[row.category] += 1;
  }
  return counts;
}

export type RevenueFilters = {
  tab: RevenueTabId;
  /** Free text over title, email and account name. */
  q: string;
  /** `all` | `stripe` | `app_store` | `ledger`. */
  source: "all" | RevenueRowSource;
};

export function filterRevenueRows(rows: readonly RevenueRow[], filters: RevenueFilters): RevenueRow[] {
  const needle = filters.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.tab !== "all" && row.category !== filters.tab) return false;
    if (filters.source !== "all" && row.source !== filters.source) return false;
    if (needle) {
      const hay = `${row.title} ${row.email ?? ""} ${row.accountName ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------- CSV

const CSV_COLUMNS = [
  "Date",
  "Type",
  "Description",
  "Account",
  "Email",
  "Source",
  "Gross",
  "Stripe fee",
  "Net",
  "Currency",
  "Stripe id",
] as const;

const CATEGORY_LABEL: Record<RevenueCategory, string> = {
  subscriptions: "Subscription",
  credits: "Credit",
  numbers: "Number",
  service_fees: "Service fee",
  payouts: "Payout",
  refunds: "Refund",
  other: "Other",
};

export function revenueCategoryLabel(category: RevenueCategory): string {
  return CATEGORY_LABEL[category];
}

/** A cell that cannot be read as a spreadsheet formula, then quoted when it needs to be. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  // Spreadsheet-formula injection: a cell that starts with these is evaluated by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== "number") text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function revenueRowsToCsv(rows: readonly RevenueRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.created.slice(0, 10)),
        csvCell(CATEGORY_LABEL[row.category]),
        csvCell(row.title),
        csvCell(row.accountName),
        csvCell(row.email),
        csvCell(row.source === "app_store" ? "App Store" : row.source === "ledger" ? "PropLane ledger" : "Stripe"),
        dollars(row.grossCents),
        dollars(row.feeCents),
        dollars(row.netCents),
        csvCell(row.currency.toUpperCase()),
        csvCell(row.id),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------- month window

export const REVENUE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isRevenueMonth(value: unknown): value is string {
  return typeof value === "string" && REVENUE_MONTH_RE.test(value);
}

/** `YYYY-MM` of the month before/after `month`. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ format

/** "$4,312" (whole dollars) or "$49.00"; a negative amount is "-$1.72". */
export function formatAdminUsd(cents: number, opts: { whole?: boolean } = {}): string {
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.whole ? 0 : 2,
    maximumFractionDigits: opts.whole ? 0 : 2,
  }).format(Math.abs(cents) / 100);
  return cents < 0 ? `-${text}` : text;
}

// -------------------------------------------------------------- Stripe links

/** `https://dashboard.stripe.com/[test/]<path>`; the test segment follows the secret key's mode. */
export function stripeDashboardUrl(path: string, testMode: boolean): string {
  const clean = path.replace(/^\/+/, "");
  return `https://dashboard.stripe.com/${testMode ? "test/" : ""}${clean}`;
}
