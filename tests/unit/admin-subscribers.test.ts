/**
 * Accounts > Subscribers: every bucket comes from the resolvers enforcement uses, so the counts here
 * are pinned against the same fixtures `resolveEffectiveManagerSkuTier` is, and the Dashboard money
 * row follows the omitted-card rule (an unknown figure is left out, never drawn as $0).
 */
import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createAdminFakeDb } from "../helpers/admin-fake-db";
import { resolveEffectiveManagerSkuTier } from "@/lib/manager-access";
import {
  classifySubscriber,
  filterSubscribers,
  monthlyCentsForPlan,
  subscriberCounts,
  subscriberMrrCents,
  subscribersToCsv,
  trialDaysLeft,
  type SubscriberInput,
  type SubscriberPurchase,
} from "@/lib/admin/admin-subscribers-model";
import { trialEndsSoon } from "@/lib/admin/admin-subscribers-shared";
import {
  enrichRenewals,
  loadAdminSubscriberFigures,
  loadSubscriberPopulation,
  pageSubscribers,
} from "@/lib/admin/admin-subscribers.server";
import { buildAdminMoneyOverview } from "@/lib/admin/admin-overview.server";
import { expenseOccursInMonth, loadMonthExpensesCents, sumExpensesForMonth } from "@/lib/admin/admin-expense-month.server";
import { EMPTY_MANAGER_BILLING_OVERRIDES } from "@/lib/manager-billing-overrides";

const NOW = Date.parse("2026-10-08T18:00:00Z");
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

function purchase(over: Partial<SubscriberPurchase>): SubscriberPurchase {
  return {
    tier: "pro",
    billing: "monthly",
    paidAt: iso(-30),
    promoCode: null,
    stripePromotionCode: null,
    stripeSubscriptionId: null,
    stripeCustomerId: null,
    stripeCheckoutSessionId: null,
    appleOriginalTransactionId: null,
    ...over,
  };
}

function input(id: string, p: SubscriberPurchase | null, over: Partial<SubscriberInput> = {}): SubscriberInput {
  return {
    id,
    email: `${id}@example.com`,
    fullName: id.toUpperCase(),
    joinedAt: iso(-60),
    purchase: p,
    planReadFailed: false,
    overrides: EMPTY_MANAGER_BILLING_OVERRIDES,
    nowMs: NOW,
    ...over,
  };
}

/** One account per bucket, plus the traps (a lapsed trial, an unreadable plan, a sandbox-free Apple grant). */
const fixtures: SubscriberInput[] = [
  input("stripe-pro", purchase({ stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" })),
  input("stripe-biz-annual", purchase({ tier: "business", billing: "annual", stripeSubscriptionId: "sub_2" })),
  input("apple", purchase({ billing: "apple", appleOriginalTransactionId: "tx1" })),
  input("trial-live", purchase({ billing: "trial", paidAt: iso(-12) })),
  input("trial-lapsed", purchase({ billing: "trial", paidAt: iso(-40) })),
  input("promo", purchase({ promoCode: "FREE100", paidAt: iso(-5) })),
  input("checkout-promo", purchase({ stripePromotionCode: "FREEFIRST", stripeSubscriptionId: "sub_4" })),
  input("comp-flag", purchase({ stripeSubscriptionId: "sub_3" }), {
    overrides: { ...EMPTY_MANAGER_BILLING_OVERRIDES, complimentary: true },
  }),
  input("admin-grant", purchase({ billing: "portal", stripeCheckoutSessionId: "admin_AX1" })),
  input("free", purchase({ tier: "free", billing: "free" })),
  input("never-bought", null),
  input("unreadable", null, { planReadFailed: true }),
];

describe("classifySubscriber buckets", () => {
  const rows = fixtures.map(classifySubscriber);
  const byId = Object.fromEntries(rows.filter(Boolean).map((r) => [r!.id, r!]));

  it("puts each account in exactly one bucket", () => {
    expect(byId["stripe-pro"]!.bucket).toBe("paid");
    expect(byId["stripe-biz-annual"]!.bucket).toBe("paid");
    expect(byId["apple"]!.bucket).toBe("paid");
    expect(byId["trial-live"]!.bucket).toBe("trial");
    expect(byId["promo"]!.bucket).toBe("promo");
    expect(byId["checkout-promo"]!.bucket).toBe("promo");
    expect(byId["comp-flag"]!.bucket).toBe("complimentary");
    expect(byId["admin-grant"]!.bucket).toBe("complimentary");
    expect(byId["free"]!.bucket).toBe("free");
    expect(byId["never-bought"]!.bucket).toBe("free");
  });

  it("files a lapsed trial under Free, the plan the product enforces", () => {
    expect(byId["trial-lapsed"]!.bucket).toBe("free");
    expect(
      resolveEffectiveManagerSkuTier({ tier: "pro", billing: "trial", paidAt: iso(-40), nowMs: NOW }),
    ).toBe("free");
  });

  it("counts an unreadable plan nowhere instead of guessing Free", () => {
    expect(byId["unreadable"]).toBeUndefined();
    expect(rows.filter((r) => r === null)).toHaveLength(1);
  });

  it("agrees with the resolver for every paid or trial account", () => {
    for (const f of fixtures) {
      const row = classifySubscriber(f);
      if (!row || !f.purchase) continue;
      const tier = resolveEffectiveManagerSkuTier({
        tier: f.purchase.tier,
        stripeSubscriptionId: f.purchase.stripeSubscriptionId,
        appleManaged: Boolean(f.purchase.appleOriginalTransactionId) && f.purchase.billing === "apple",
        billing: f.purchase.billing,
        paidAt: f.purchase.paidAt,
        nowMs: NOW,
      });
      expect(row.tier).toBe(tier);
    }
  });

  it("counts the buckets and computes MRR from Paid only, at list price", () => {
    const list = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(subscriberCounts(list)).toEqual({ paid: 3, trial: 1, promo: 2, free: 3, complimentary: 2 });
    // Pro monthly $49 x2 (Stripe + Apple) + Business annual $2,490 / 12 = $207.50.
    expect(subscriberMrrCents(list)).toBe(4900 * 2 + Math.round(249_000 / 12));
  });

  it("monthly equivalent: annual divides by twelve, Free pays nothing", () => {
    expect(monthlyCentsForPlan("pro", "monthly")).toBe(4900);
    expect(monthlyCentsForPlan("business", "annual")).toBe(Math.round(249_000 / 12));
    expect(monthlyCentsForPlan("free", "free")).toBeNull();
  });

  it("labels the plan and the source", () => {
    expect(byId["stripe-pro"]).toMatchObject({ planLabel: "Pro monthly", source: "stripe" });
    expect(byId["stripe-biz-annual"]!.planLabel).toBe("Business annual");
    expect(byId["apple"]!.source).toBe("app_store");
    expect(byId["trial-live"]).toMatchObject({ planLabel: "Pro trial", source: "proplane" });
    expect(byId["promo"]!.promoCode).toBe("FREE100");
    expect(byId["checkout-promo"]!.promoCode).toBe("FREEFIRST");
  });
});

describe("the Promo bucket reads stripe_promotion_code", () => {
  it("a Stripe-billed account with a redeemed checkout code is Promo and shows that code", () => {
    const row = classifySubscriber(
      input("m", purchase({ stripeSubscriptionId: "sub_9", stripePromotionCode: "FREEFIRST" })),
    )!;
    expect(row.bucket).toBe("promo");
    expect(row.promoCode).toBe("FREEFIRST");
  });

  it("a plain paid account with no redeemed code stays Paid", () => {
    expect(classifySubscriber(input("m", purchase({ stripeSubscriptionId: "sub_9" })))!.bucket).toBe("paid");
  });
});

describe("trials", () => {
  it("counts calendar days to the trial end and flags the last three as soon", () => {
    expect(trialDaysLeft("2026-10-10", NOW)).toBe(2);
    expect(trialDaysLeft("2026-10-08", NOW)).toBe(0);
    expect(trialDaysLeft("2026-10-01", NOW)).toBe(0);
    expect(trialEndsSoon({ trialDaysLeft: 3 })).toBe(true);
    expect(trialEndsSoon({ trialDaysLeft: 4 })).toBe(false);
    expect(trialEndsSoon({ trialDaysLeft: null })).toBe(false);
  });

  it("honours a staff-extended trial end and sorts the Trial tab soonest first", () => {
    const soon = classifySubscriber(input("soon", purchase({ billing: "trial", paidAt: iso(-12) })))!; // ends day 2
    const later = classifySubscriber(
      input("later", purchase({ billing: "trial", paidAt: iso(-1) }), {
        overrides: { ...EMPTY_MANAGER_BILLING_OVERRIDES, trialEndsAt: "2026-10-30" },
      }),
    )!;
    expect(later.trialEndsAt).toBe("2026-10-30");
    const sorted = filterSubscribers([later, soon], { tab: "trial", q: "", plan: "all", source: "all", signup: "" });
    expect(sorted.map((r) => r.id)).toEqual(["soon", "later"]);
    expect(soon.trialDaysLeft).toBe(2);
  });
});

describe("filters and CSV", () => {
  const list = fixtures.map(classifySubscriber).filter((r): r is NonNullable<typeof r> => r !== null);

  it("filters the Paid tab by plan, source and text", () => {
    const f = { tab: "paid" as const, q: "", plan: "all" as const, source: "all" as const, signup: "" };
    expect(filterSubscribers(list, f)).toHaveLength(3);
    expect(filterSubscribers(list, { ...f, plan: "business" }).map((r) => r.id)).toEqual(["stripe-biz-annual"]);
    expect(filterSubscribers(list, { ...f, source: "app_store" }).map((r) => r.id)).toEqual(["apple"]);
    expect(filterSubscribers(list, { ...f, q: "STRIPE-PRO" })).toHaveLength(1);
  });

  it("downloads every filtered row with safe cells", () => {
    const csv = subscribersToCsv(list.filter((r) => r.bucket === "promo"));
    const [head, line] = csv.trimEnd().split("\r\n");
    expect(head).toContain("Promo code");
    expect(line).toContain("FREE100");
    expect(line).toContain("49.00");
  });
});

describe("loadSubscriberPopulation (paged reads, resolvers, sandbox excluded)", () => {
  function db(paidOver: Record<string, unknown> = {}) {
    return createAdminFakeDb({
      profile_roles: [
        { user_id: "m-paid", role: "manager" },
        { user_id: "m-trial", role: "manager" },
        { user_id: "m-free", role: "manager" },
        { user_id: "m-comp", role: "manager" },
        { user_id: "m-sandbox", role: "manager" },
      ],
      profiles: [
        { id: "m-paid", email: "paid@real.com", full_name: "Paid Co", created_at: iso(-90) },
        { id: "m-trial", email: "trial@real.com", full_name: "Trial Co", created_at: iso(-3) },
        { id: "m-free", email: "free@real.com", full_name: "Free Co", created_at: iso(-20) },
        { id: "m-comp", email: "comp@real.com", full_name: "Comp Co", created_at: iso(-20) },
        { id: "m-sandbox", email: "demo@axis.local", full_name: "Demo", created_at: iso(-1) },
      ],
      manager_purchases: [
        { id: "p1", user_id: "m-paid", email: "paid@real.com", tier: "business", billing: "monthly", paid_at: iso(-40), stripe_subscription_id: "sub_p", stripe_customer_id: "cus_p", ...paidOver },
        // Tied to the account by email only, exactly as the plan resolver merges them.
        { id: "p2", user_id: null, email: "trial@real.com", tier: "pro", billing: "trial", paid_at: iso(-3) },
        { id: "p3", user_id: "m-sandbox", email: "demo@axis.local", tier: "pro", billing: "monthly", paid_at: iso(-3), stripe_subscription_id: "sub_demo" },
      ],
      manager_automation_settings: [{ manager_user_id: "m-comp", comp: "true", trial: null }],
    }) as never;
  }

  it("buckets real accounts, applies the complimentary override and leaves the sandbox out", async () => {
    const pop = await loadSubscriberPopulation(db(), NOW);
    const bucket = Object.fromEntries(pop.rows.map((r) => [r.id, r.bucket]));
    expect(bucket).toEqual({ "m-paid": "paid", "m-trial": "trial", "m-free": "free", "m-comp": "complimentary" });
    expect(pop.unreadable).toBe(0);
    const p = pageSubscribers(pop, { tab: "paid", q: "", plan: "all", source: "all", signup: "" }, 1, 50);
    expect(p).toMatchObject({ total: 1, counts: { paid: 1, trial: 1, promo: 0, free: 1, complimentary: 1 }, mrrCents: 24_900 });
  });

  it("loads stripe_promotion_code from manager_purchases into the Promo bucket", async () => {
    const pop = await loadSubscriberPopulation(db({ stripe_promotion_code: "FREEFIRST" }), NOW);
    const paid = pop.rows.find((r) => r.id === "m-paid")!;
    expect(paid.bucket).toBe("promo");
    expect(paid.promoCode).toBe("FREEFIRST");
  });

  it("fails loudly (no zeroes) when a read fails", async () => {
    const broken = {
      from: (table: string) => {
        if (table === "manager_purchases") {
          const b: Record<string, unknown> = {};
          for (const verb of ["select", "order", "range", "eq", "not", "in", "ilike"]) b[verb] = () => b;
          b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: new Error("boom") });
          return b;
        }
        return (createAdminFakeDb({ profile_roles: [], profiles: [] }) as unknown as { from: (t: string) => unknown }).from(table);
      },
    } as never;
    await expect(loadSubscriberPopulation(broken, NOW)).rejects.toBeDefined();
    expect(await loadAdminSubscriberFigures(broken, NOW)).toBeNull();
  });

  it("pages in blocks and enriches the visible rows' renewal from Stripe, leaving a miss blank", async () => {
    const pop = await loadSubscriberPopulation(db(), NOW);
    const page = pageSubscribers(pop, { tab: "paid", q: "", plan: "all", source: "all", signup: "" }, 1, 50);
    const stripe = {
      subscriptions: { retrieve: vi.fn(async () => ({ status: "active", items: { data: [{ current_period_end: 1_793_000_000 }] } })) },
    } as unknown as Stripe;
    const [row] = await enrichRenewals(page.rows, { stripe: () => stripe });
    expect(row!.renewsAt).toBe(new Date(1_793_000_000 * 1000).toISOString());
    const down = await enrichRenewals(page.rows, {
      stripe: () => {
        throw new Error("no key");
      },
    });
    expect(down[0]!.renewsAt).toBeNull();
  });
});

describe("Dashboard money row: an unknown source omits its card", () => {
  const subscribers = { counts: { paid: 61, trial: 14, promo: 9 }, mrrCents: 431_200 };
  const earnings = { earnedCents: 398_000, stripeFeesCents: 14_200 };

  it("computes profit = earned - Stripe fees - expenses", () => {
    expect(buildAdminMoneyOverview({ subscribers, earnings, expensesCents: 169_800 })).toEqual({
      mrrCents: 431_200,
      earnedCents: 398_000,
      profitCents: 214_000,
      paidSubscribers: 61,
      onTrial: 14,
      promoUsers: 9,
    });
  });

  it("returns null, never 0, for each figure whose source is unavailable", () => {
    const noStripe = buildAdminMoneyOverview({ subscribers, earnings: null, expensesCents: 100 });
    expect(noStripe.earnedCents).toBeNull();
    expect(noStripe.profitCents).toBeNull();
    expect(noStripe.mrrCents).toBe(431_200);

    const noExpenses = buildAdminMoneyOverview({ subscribers, earnings, expensesCents: null });
    expect(noExpenses.profitCents).toBeNull();
    expect(noExpenses.earnedCents).toBe(398_000);

    const nothing = buildAdminMoneyOverview({ subscribers: null, earnings: null, expensesCents: null });
    expect(Object.values(nothing).every((v) => v === null)).toBe(true);
  });

  it("keeps a real zero as zero: no sales yet is $0, not omitted", () => {
    const zero = buildAdminMoneyOverview({
      subscribers: { counts: { paid: 0, trial: 0, promo: 0 }, mrrCents: 0 },
      earnings: { earnedCents: 0, stripeFeesCents: 0 },
      expensesCents: 0,
    });
    expect(zero).toMatchObject({ mrrCents: 0, earnedCents: 0, profitCents: 0, paidSubscribers: 0 });
  });

  it("the Dashboard draws a card only for a non-null figure, and links each to its page", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/portal/admin-dashboard.tsx", "utf8");
    for (const key of ["mrrCents", "earnedCents", "profitCents", "paidSubscribers", "onTrial", "promoUsers"]) {
      expect(src).toContain(`overview.money?.${key} != null`);
    }
    for (const href of ["/admin/subscribers?tab=paid", "/admin/payments", "/admin/finances", "/admin/subscribers?tab=trial", "/admin/subscribers?tab=promo"]) {
      expect(src).toContain(`href="${href}"`);
    }
  });
});

describe("platform expenses for the Profit card (read defensively)", () => {
  it("places one-time, monthly and yearly expenses in the right months", () => {
    const rows = [
      { amount_cents: 2000, spent_on: "2026-10-01", recurrence: "monthly", ends_on: null },
      { amount_cents: 5000, spent_on: "2026-10-15", recurrence: "none", ends_on: null },
      { amount_cents: 9900, spent_on: "2025-10-20", recurrence: "yearly", ends_on: null },
      { amount_cents: 700, spent_on: "2026-01-01", recurrence: "monthly", ends_on: "2026-09-30" },
    ];
    expect(sumExpensesForMonth(rows, "2026-10")).toBe(2000 + 5000 + 9900);
    expect(sumExpensesForMonth(rows, "2026-11")).toBe(2000);
    expect(expenseOccursInMonth(rows[0]!, "2026-09")).toBe(false);
    expect(expenseOccursInMonth(rows[3]!, "2026-09")).toBe(true);
    expect(expenseOccursInMonth(rows[3]!, "2026-10")).toBe(false);
  });

  it("reads zero from an empty table, and null (omit) when the table is missing", async () => {
    const empty = createAdminFakeDb({ platform_expenses: [] }) as never;
    expect(await loadMonthExpensesCents(empty, "2026-10")).toBe(0);
    const missing = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const verb of ["select", "order", "range"]) b[verb] = () => b;
        b.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: { code: "42P01", message: 'relation "platform_expenses" does not exist' } });
        return b;
      },
    } as never;
    expect(await loadMonthExpensesCents(missing, "2026-10")).toBeNull();
  });
});
