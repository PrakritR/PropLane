/**
 * Money > Payments: classification, the stat strip, the CSV, and the five-minute cache - with Stripe
 * mocked. The platform Stripe account also carries pass-through money (rent, vendor payments), so the
 * rule pinned hardest here is that only PropLane's own earnings reach gross, fees and refunds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createAdminFakeDb } from "../helpers/admin-fake-db";
import {
  classifyBalanceTransaction,
  EMPTY_CLASSIFY_CONTEXT,
  filterRevenueRows,
  formatAdminUsd,
  planLabelFromPriceIds,
  revenueRowsToCsv,
  revenueTabCounts,
  shiftMonth,
  stripeDashboardUrl,
  summarizeRevenue,
  csvCell,
  type ClassifyContext,
  type NormalizedBalanceTransaction,
} from "@/lib/admin/admin-revenue-model";
import {
  clearAdminRevenueCache,
  loadAdminRevenueMonth,
  normalizeBalanceTransaction,
  pageRevenue,
  revenueMonthWindow,
  REVENUE_CACHE_TTL_MS,
} from "@/lib/admin/admin-revenue.server";

function bt(over: Partial<NormalizedBalanceTransaction>): NormalizedBalanceTransaction {
  return {
    id: "txn_1",
    type: "charge",
    reportingCategory: "charge",
    amount: 4900,
    fee: 172,
    net: 4728,
    currency: "usd",
    created: 1_791_000_000,
    description: null,
    sourceKind: "charge",
    sourceId: "ch_1",
    metadata: {},
    customerId: "cus_1",
    email: "jacko2544@gmail.com",
    paymentIntentId: "pi_1",
    chargeId: null,
    payout: null,
    ...over,
  };
}

const ctx: ClassifyContext = {
  ...EMPTY_CLASSIFY_CONTEXT,
  accountByCustomerId: new Map([["cus_1", { accountId: "user-1", name: "Seattle Homes", email: "jacko2544@gmail.com" }]]),
  accountByUserId: new Map([["user-2", { accountId: "user-2", name: "Pine Street", email: "pine@example.com" }]]),
  subscriptionCustomerIds: new Set(["cus_1"]),
};

describe("classifyBalanceTransaction", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_m");
    vi.stubEnv("STRIPE_PRICE_BUSINESS_ANNUAL", "price_biz_a");
  });

  it("calls a charge on an invoice with a Pro monthly price a subscription, titled by plan and account", () => {
    const row = classifyBalanceTransaction(
      bt({}),
      {
        ...ctx,
        invoiceByPaymentIntent: new Map([
          ["pi_1", { invoiceId: "in_1", isSubscription: true, priceIds: ["price_pro_m"], lineDescription: null, hostedInvoiceUrl: "https://x" }],
        ]),
      },
    );
    expect(row).toMatchObject({
      category: "subscriptions",
      title: "Pro monthly - Seattle Homes",
      accountId: "user-1",
      grossCents: 4900,
      feeCents: 172,
      netCents: 4728,
      stripePath: "payments/ch_1",
      invoiceId: "in_1",
    });
  });

  it("maps a Business annual price id to its label, and an unknown price to null", () => {
    expect(planLabelFromPriceIds(["price_biz_a"])).toBe("Business annual");
    expect(planLabelFromPriceIds(["price_other"])).toBeNull();
  });

  it("falls back to the customer's subscription when no invoice was read", () => {
    expect(classifyBalanceTransaction(bt({}), ctx).category).toBe("subscriptions");
  });

  it("classifies a messaging credit pack by its checkout purpose and links the account from metadata", () => {
    const row = classifyBalanceTransaction(
      bt({ amount: 2000, fee: 88, net: 1912, customerId: null, metadata: { purpose: "manager_communication_credit", manager_user_id: "user-2" } }),
      ctx,
    );
    expect(row).toMatchObject({ category: "credits", accountId: "user-2", title: "Messaging credit - Pine Street" });
  });

  it("classifies a PropLane Number charge by purpose", () => {
    const row = classifyBalanceTransaction(
      bt({ amount: 500, fee: 45, net: 455, customerId: "cus_x", metadata: { purpose: "number_subscription" } }),
      ctx,
    );
    expect(row.category).toBe("numbers");
    expect(row.title).toMatch(/^PropLane Number/);
  });

  it("leaves a charge it cannot attribute as other, never as revenue", () => {
    const row = classifyBalanceTransaction(
      bt({ customerId: "cus_rent", description: "Rent for unit 4", metadata: { purpose: "household_charge" } }),
      ctx,
    );
    expect(row.category).toBe("other");
  });

  it("classifies payouts with the bank and arrival date", () => {
    const row = classifyBalanceTransaction(
      bt({
        id: "txn_po",
        type: "payout",
        reportingCategory: "payout",
        amount: -100000,
        fee: 0,
        net: -100000,
        sourceKind: "payout",
        sourceId: "po_1",
        customerId: null,
        payout: { arrivalDate: 1_791_200_000, bankLast4: "6789", status: "paid" },
      }),
      ctx,
    );
    expect(row).toMatchObject({ category: "payouts", title: "Payout to bank ****6789", stripePath: "payouts/po_1" });
    expect(row.payout?.arrivalDate).toBe(new Date(1_791_200_000 * 1000).toISOString());
  });

  it("counts a refund of PropLane revenue as a refund, and a refund of rent as other", () => {
    const refund = bt({ id: "txn_re", type: "refund", reportingCategory: "refund", amount: -4900, fee: 0, net: -4900, sourceKind: "refund", sourceId: "re_1", chargeId: "ch_sub", customerId: null });
    const ours = classifyBalanceTransaction(refund, {
      ...ctx,
      chargeCategory: new Map([["ch_sub", { category: "subscriptions", title: "Pro monthly - Seattle Homes" }]]),
    });
    expect(ours).toMatchObject({ category: "refunds", title: "Refund - Pro monthly - Seattle Homes", chargeId: "ch_sub" });

    const rent = classifyBalanceTransaction(refund, {
      ...ctx,
      chargeCategory: new Map([["ch_sub", { category: "other", title: "Rent" }]]),
    });
    expect(rent.category).toBe("other");
    // Unresolved original: never assumed to be ours.
    expect(classifyBalanceTransaction(refund, ctx).category).toBe("other");
  });
});

describe("summary, tabs, filters", () => {
  const rows = [
    classifyBalanceTransaction(bt({}), ctx),
    classifyBalanceTransaction(bt({ id: "txn_2", amount: 2000, fee: 88, net: 1912, customerId: null, metadata: { purpose: "manager_communication_credit" } }), ctx),
    classifyBalanceTransaction(bt({ id: "txn_3", customerId: "cus_rent", amount: 150000, fee: 4400, net: 145600, metadata: { purpose: "household_charge" } }), ctx),
    classifyBalanceTransaction(
      bt({ id: "txn_4", type: "refund", reportingCategory: "refund", amount: -900, fee: 0, net: -900, sourceKind: "refund", chargeId: "ch_sub", customerId: null }),
      { ...ctx, chargeCategory: new Map([["ch_sub", { category: "subscriptions", title: "Pro" }]]) },
    ),
    classifyBalanceTransaction(bt({ id: "txn_5", type: "payout", reportingCategory: "payout", amount: -5000, fee: 0, net: -5000, sourceKind: "payout", customerId: null }), ctx),
  ];

  it("adds up only PropLane's own earnings: rent and payouts never reach gross or fees", () => {
    const s = summarizeRevenue(rows);
    expect(s.grossCents).toBe(6900);
    expect(s.stripeFeesCents).toBe(260);
    expect(s.refundsCents).toBe(900);
    expect(s.earnedCents).toBe(6000);
    expect(s.netCents).toBe(6000 - 260);
    expect(s.byCategory).toMatchObject({ subscriptions: 4900, credits: 2000 });
  });

  it("counts tabs without counting other, and All counts every row", () => {
    expect(revenueTabCounts(rows)).toEqual({
      all: 5,
      subscriptions: 1,
      credits: 1,
      numbers: 0,
      service_fees: 0,
      payouts: 1,
      refunds: 1,
    });
  });

  it("filters by tab, source and text", () => {
    expect(filterRevenueRows(rows, { tab: "credits", q: "", source: "all" })).toHaveLength(1);
    expect(filterRevenueRows(rows, { tab: "all", q: "seattle", source: "all" }).every((r) => /seattle/i.test(r.title + (r.accountName ?? "")))).toBe(true);
    expect(filterRevenueRows(rows, { tab: "all", q: "", source: "app_store" })).toHaveLength(0);
  });

  it("treats a service-fee reversal as negative revenue", () => {
    const base = rows[0]!;
    const fee = { ...base, id: "fee:a", source: "ledger" as const, category: "service_fees" as const, grossCents: 300, feeCents: 0, netCents: 300 };
    const reversal = { ...fee, id: "fee:b", grossCents: -100, netCents: -100 };
    expect(summarizeRevenue([fee, reversal]).byCategory.service_fees).toBe(200);
  });
});

describe("CSV", () => {
  it("writes a header, dollars with cents, and one line per row", () => {
    const row = classifyBalanceTransaction(bt({}), ctx);
    const lines = revenueRowsToCsv([row]).trimEnd().split("\r\n");
    expect(lines[0]).toBe("Date,Type,Description,Account,Email,Source,Gross,Stripe fee,Net,Currency,Stripe id");
    expect(lines[1]).toContain(",49.00,1.72,47.28,USD,txn_1");
  });

  it("quotes commas and quotes, and defuses spreadsheet formulas", () => {
    expect(csvCell('Acme, "Inc"')).toBe('"Acme, ""Inc"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1 206")).toBe("'+1 206");
    expect(csvCell(null)).toBe("");
  });
});

describe("small helpers", () => {
  it("formats money, shifts months, builds dashboard links", () => {
    expect(formatAdminUsd(4900)).toBe("$49.00");
    expect(formatAdminUsd(431200, { whole: true })).toBe("$4,312");
    expect(formatAdminUsd(-172)).toBe("-$1.72");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(stripeDashboardUrl("/payments/ch_1", true)).toBe("https://dashboard.stripe.com/test/payments/ch_1");
    expect(stripeDashboardUrl("payments", false)).toBe("https://dashboard.stripe.com/payments");
  });

  it("derives a Pacific month window and rejects a malformed month", () => {
    const w = revenueMonthWindow("2026-10")!;
    expect(w.endMs).toBeGreaterThan(w.startMs);
    expect((w.endMs - w.startMs) / 86_400_000).toBeCloseTo(31, 0);
    expect(revenueMonthWindow("2026-13")).toBeNull();
    expect(revenueMonthWindow("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------- server / cache

function stripeFake(opts: { bts?: unknown[]; fail?: boolean } = {}) {
  const btList = vi.fn(() => ({
    autoPagingToArray: async () => {
      if (opts.fail) throw new Error("stripe down");
      return opts.bts ?? [];
    },
  }));
  const stripe = {
    balanceTransactions: { list: btList },
    invoices: { list: () => ({ autoPagingToArray: async () => [] }) },
    payouts: {
      list: async () => ({ data: [{ status: "in_transit", amount: 120000, arrival_date: 1_791_300_000 }] }),
      retrieve: async () => ({ destination: { last4: "6789" } }),
    },
    balance: { retrieve: async () => ({ available: [] }) },
    charges: { retrieve: async () => ({ id: "ch_sub", amount: 4900, currency: "usd", created: 1, metadata: {}, customer: "cus_1", payment_intent: null }) },
  } as unknown as Stripe;
  return { stripe, btList };
}

const chargeBt = {
  id: "txn_a",
  type: "charge",
  reporting_category: "charge",
  amount: 4900,
  fee: 172,
  net: 4728,
  currency: "usd",
  created: 1_791_000_000,
  description: null,
  source: { object: "charge", id: "ch_a", metadata: { purpose: "manager_communication_credit", manager_user_id: "user-2" }, customer: "cus_9", billing_details: { email: "pine@example.com" }, payment_intent: "pi_a" },
};

describe("loadAdminRevenueMonth", () => {
  beforeEach(() => clearAdminRevenueCache());

  const db = () =>
    createAdminFakeDb({
      manager_purchases: [],
      profiles: [{ id: "user-2", email: "pine@example.com", full_name: "Pine Street" }],
      manager_comms_billing_accounts: [],
      platform_revenue_entries: [],
    }) as never;

  it("reads Stripe once per five minutes per month, then again after the TTL", async () => {
    const { stripe, btList } = stripeFake({ bts: [chargeBt] });
    let now = 1_000_000;
    const deps = { stripe: () => stripe, now: () => now };
    const first = await loadAdminRevenueMonth(db(), "2026-10", deps);
    expect(first.ok).toBe(true);
    now += REVENUE_CACHE_TTL_MS - 1;
    await loadAdminRevenueMonth(db(), "2026-10", deps);
    expect(btList).toHaveBeenCalledTimes(1);
    now += 2;
    await loadAdminRevenueMonth(db(), "2026-10", deps);
    expect(btList).toHaveBeenCalledTimes(2);
    // A different month is its own cache entry.
    await loadAdminRevenueMonth(db(), "2026-09", deps);
    expect(btList).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const { stripe, btList } = stripeFake({ bts: [chargeBt] });
    const deps = { stripe: () => stripe };
    await Promise.all([loadAdminRevenueMonth(db(), "2026-10", deps), loadAdminRevenueMonth(db(), "2026-10", deps)]);
    expect(btList).toHaveBeenCalledTimes(1);
  });

  it("classifies, links the account and carries the next payout", async () => {
    const { stripe } = stripeFake({ bts: [chargeBt] });
    const result = await loadAdminRevenueMonth(db(), "2026-10", { stripe: () => stripe });
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.rows[0]).toMatchObject({ category: "credits", accountId: "user-2", accountName: "Pine Street" });
    expect(result.data.summary.grossCents).toBe(4900);
    expect(result.data.nextPayout).toMatchObject({ amountCents: 120000, scheduled: true });
  });

  it("never caches a failure: stripe_error, then a retry succeeds", async () => {
    const failing = stripeFake({ fail: true });
    const res = await loadAdminRevenueMonth(db(), "2026-10", { stripe: () => failing.stripe });
    expect(res).toEqual({ ok: false, reason: "stripe_error" });
    const good = stripeFake({ bts: [chargeBt] });
    expect((await loadAdminRevenueMonth(db(), "2026-10", { stripe: () => good.stripe })).ok).toBe(true);
  });

  it("reports stripe_unavailable when the client cannot be built", async () => {
    const res = await loadAdminRevenueMonth(db(), "2026-10", {
      stripe: () => {
        throw new Error("Missing STRIPE_SECRET_KEY");
      },
    });
    expect(res).toEqual({ ok: false, reason: "stripe_unavailable" });
  });

  it("adds App Store subscriptions and the vendor service-fee ledger as their own rows", async () => {
    const { stripe } = stripeFake({ bts: [] });
    const w = revenueMonthWindow("2026-10")!;
    const inside = new Date(w.startMs + 86_400_000).toISOString();
    const fake = createAdminFakeDb({
      manager_purchases: [
        { id: "p1", user_id: "user-3", email: "a@x.com", full_name: "Apple Co", tier: "pro", billing: "apple", paid_at: inside, apple_original_transaction_id: "tx1", apple_environment: "Production" },
        { id: "p2", user_id: "user-4", email: "b@x.com", full_name: "Sandbox Co", tier: "pro", billing: "apple", paid_at: inside, apple_original_transaction_id: "tx2", apple_environment: "Sandbox" },
      ],
      profiles: [{ id: "user-9", email: "m@x.com", full_name: "Manager" }],
      platform_revenue_entries: [
        { id: "e1", kind: "vendor_service_fee", amount_cents: 300, manager_user_id: "user-9", description: "fee", created_at: inside },
        { id: "e2", kind: "vendor_service_fee_reversal", amount_cents: -100, manager_user_id: "user-9", description: "refund", created_at: inside },
      ],
    }) as never;
    const result = await loadAdminRevenueMonth(fake, "2026-10", { stripe: () => stripe });
    if (!result.ok) throw new Error("expected ok");
    const apple = result.data.rows.filter((r) => r.source === "app_store");
    expect(apple).toHaveLength(1);
    expect(apple[0]).toMatchObject({ category: "subscriptions", grossCents: 4900, accountName: "Apple Co" });
    expect(result.data.summary.byCategory.service_fees).toBe(200);
    expect(result.data.counts.service_fees).toBe(2);
  });
});

describe("normalizeBalanceTransaction and paging", () => {
  it("reads a charge's metadata, customer, email and payment intent off the expanded source", () => {
    const n = normalizeBalanceTransaction(chargeBt as unknown as Stripe.BalanceTransaction);
    expect(n).toMatchObject({ sourceKind: "charge", customerId: "cus_9", email: "pine@example.com", paymentIntentId: "pi_a" });
    expect(n.metadata.purpose).toBe("manager_communication_credit");
  });

  it("treats an unexpanded source as unattributable", () => {
    const n = normalizeBalanceTransaction({ ...chargeBt, source: "ch_a" } as unknown as Stripe.BalanceTransaction);
    expect(n.sourceKind).toBe("other");
  });

  it("pages and clamps", () => {
    const rows = Array.from({ length: 120 }, (_, i) => classifyBalanceTransaction(bt({ id: `txn_${i}`, created: 1_791_000_000 - i }), ctx));
    const data = {
      month: "2026-10",
      rows,
      summary: summarizeRevenue(rows),
      counts: revenueTabCounts(rows),
      truncated: false,
      testMode: true,
      nextPayout: null,
      generatedAt: "x",
    };
    const p = pageRevenue(data, { tab: "all", q: "", source: "all" }, 3, 50);
    expect(p).toMatchObject({ total: 120, page: 3, pageSize: 50 });
    expect(p.rows).toHaveLength(20);
    expect(pageRevenue(data, { tab: "all", q: "", source: "all" }, 1, 9999).pageSize).toBe(100);
  });
});
