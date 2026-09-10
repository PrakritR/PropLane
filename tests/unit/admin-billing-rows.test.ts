/**
 * Admin Billing rows: what staff are told each manager account is held to.
 *
 * The failure this file exists to prevent is the one the plan layer already learned once — an
 * account whose plan could not be READ rendering as "Free". Zero purchase rows come back both when
 * an account never bought anything and when the read failed, and the first resolves to Free, so a
 * screen that collapses them tells staff a paying Business customer is on the free tier and that
 * their sixth listing was correctly refused.
 *
 * The rest of it pins that every number on the screen comes from the resolver enforcement uses:
 * the cap is `maxPropertiesForManagerTier` under the staff override, the fee payer is
 * `resolveServiceFeePayerFor`, and a lapsed signup trial reads Free here exactly as it does to the
 * property cap.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_BILLING_TABS,
  adminBillingRowMatchesTab,
  adminBillingTabCounts,
  adminBillingTabFromParam,
  deriveAdminBillingRow,
  type AdminBillingRowInput,
} from "@/lib/admin-billing-rows";
import { BUSINESS_MAX_PROPERTIES, FREE_MAX_PROPERTIES, PRO_MAX_PROPERTIES } from "@/lib/manager-access";
import { EMPTY_MANAGER_BILLING_OVERRIDES } from "@/lib/manager-billing-overrides";

const NOW = Date.parse("2026-09-07T00:00:00.000Z");

function input(over: Partial<AdminBillingRowInput> = {}): AdminBillingRowInput {
  return {
    id: "mgr-1",
    email: "mgr@test.proplane.local",
    fullName: "Mgr One",
    managerId: "AXIS-1",
    active: true,
    joinedAt: "2026-01-01T00:00:00.000Z",
    purchase: null,
    planReadFailed: false,
    listedCount: 0,
    overrides: EMPTY_MANAGER_BILLING_OVERRIDES,
    managerFeeChoice: null,
    adminFeeOverride: null,
    commsUsedCents: 0,
    commsHasPaymentMethod: false,
    nowMs: NOW,
    ...over,
  };
}

const purchase = (over: Partial<NonNullable<AdminBillingRowInput["purchase"]>> = {}) => ({
  tier: null,
  billing: null,
  paidAt: null,
  stripeSubscriptionId: null,
  appleOriginalTransactionId: null,
  promoCode: null,
  ...over,
});

describe("a plan that cannot be read", () => {
  const row = deriveAdminBillingRow(input({ planReadFailed: true, listedCount: 4 }));

  it("says Plan unknown, never Free", () => {
    expect(row.planLabel).toBe("Plan unknown");
    expect(row.planUnknown).toBe(true);
    expect(row.tier).toBeNull();
  });

  it("prints nothing derived from the plan it could not read", () => {
    // A cap, a fee payer or an allowance shown here would be a confident wrong answer about
    // somebody's money.
    expect(row.propertyLimit).toBeNull();
    expect(row.atPropertyLimit).toBe(false);
    expect(row.serviceFeePayer).toBeNull();
    expect(row.comms).toBeNull();
  });

  it("still reports what it DID read", () => {
    expect(row.listedCount).toBe(4);
  });

  it("appears under All and nowhere else — never filed as Free", () => {
    expect(adminBillingRowMatchesTab(row, "all")).toBe(true);
    expect(adminBillingRowMatchesTab(row, "free")).toBe(false);
    expect(adminBillingRowMatchesTab(row, "pro")).toBe(false);
    expect(adminBillingRowMatchesTab(row, "trial")).toBe(false);
  });

  it("keeps a staff-pinned cap, which does not depend on the plan read", () => {
    const pinned = deriveAdminBillingRow(
      input({
        planReadFailed: true,
        listedCount: 6,
        overrides: { propertyCap: 5, trialEndsAt: null, complimentary: false },
      }),
    );
    expect(pinned.propertyLimit).toBe(5);
    expect(pinned.propertyLimitIsOverride).toBe(true);
    expect(pinned.atPropertyLimit).toBe(true);
  });
});

describe("the plan the product enforces", () => {
  it("an account with no purchase row is Free, with the Free cap", () => {
    const row = deriveAdminBillingRow(input({ listedCount: FREE_MAX_PROPERTIES }));
    expect(row.tier).toBe("free");
    expect(row.propertyLimit).toBe(FREE_MAX_PROPERTIES);
    expect(row.atPropertyLimit).toBe(true);
  });

  it("a live Stripe subscription keeps its plan and cap", () => {
    const row = deriveAdminBillingRow(
      input({ purchase: purchase({ tier: "business", stripeSubscriptionId: "sub_1" }), listedCount: 3 }),
    );
    expect(row.tier).toBe("business");
    expect(row.propertyLimit).toBe(BUSINESS_MAX_PROPERTIES);
    expect(row.atPropertyLimit).toBe(false);
  });

  it("a LIVE signup trial reads as its paid plan and shows when it ends", () => {
    const row = deriveAdminBillingRow(
      input({ purchase: purchase({ tier: "pro", billing: "trial", paidAt: "2026-09-01T00:00:00.000Z" }) }),
    );
    expect(row.tier).toBe("pro");
    expect(row.propertyLimit).toBe(PRO_MAX_PROPERTIES);
    expect(row.onTrial).toBe(true);
    expect(row.trialLapsed).toBe(false);
    expect(row.trialEndsAt).toBe("2026-09-15");
    expect(adminBillingRowMatchesTab(row, "trial")).toBe(true);
  });

  it("a LAPSED signup trial reads Free — the row still stores pro forever", () => {
    // The stored row keeps `tier: pro, billing: trial` for the life of the account; only the date
    // says it ran out. A screen reading `tier` alone would show Pro next to the Free cap the
    // manager is actually held to.
    const row = deriveAdminBillingRow(
      input({ purchase: purchase({ tier: "pro", billing: "trial", paidAt: "2026-01-01T00:00:00.000Z" }) }),
    );
    expect(row.tier).toBe("free");
    expect(row.propertyLimit).toBe(FREE_MAX_PROPERTIES);
    expect(row.trialLapsed).toBe(true);
    expect(row.onTrial).toBe(false);
    expect(adminBillingRowMatchesTab(row, "free")).toBe(true);
    expect(adminBillingRowMatchesTab(row, "trial")).toBe(false);
  });

  it("edits the STORED sku, not the resolved one", () => {
    // The account editor's Plan select is bound to `storedTier`; binding it to the enforced tier
    // would commit a lapsed trial to Free the first time staff saved anything.
    const row = deriveAdminBillingRow(
      input({ purchase: purchase({ tier: "pro", billing: "trial", paidAt: "2026-01-01T00:00:00.000Z" }) }),
    );
    expect(row.storedTier).toBe("pro");
    expect(row.tier).toBe("free");
  });
});

describe("the staff property-cap override", () => {
  it("replaces the plan cap in both directions", () => {
    const lifted = deriveAdminBillingRow(
      input({ overrides: { propertyCap: 12, trialEndsAt: null, complimentary: false }, listedCount: 4 }),
    );
    expect(lifted.propertyLimit).toBe(12);
    expect(lifted.propertyLimitIsOverride).toBe(true);
    expect(lifted.atPropertyLimit).toBe(false);

    const lowered = deriveAdminBillingRow(
      input({
        purchase: purchase({ tier: "business", stripeSubscriptionId: "sub_1" }),
        overrides: { propertyCap: 2, trialEndsAt: null, complimentary: false },
        listedCount: 2,
      }),
    );
    expect(lowered.propertyLimit).toBe(2);
    expect(lowered.atPropertyLimit).toBe(true);
  });

  it("treats 0 as a real cap, not as absent", () => {
    const row = deriveAdminBillingRow(
      input({ overrides: { propertyCap: 0, trialEndsAt: null, complimentary: false }, listedCount: 0 }),
    );
    expect(row.propertyLimit).toBe(0);
    expect(row.propertyLimitIsOverride).toBe(true);
    expect(row.atPropertyLimit).toBe(true);
  });

  it("shows an overridden trial end in place of the derived one, and says which it is", () => {
    const row = deriveAdminBillingRow(
      input({
        purchase: purchase({ tier: "pro", billing: "trial", paidAt: "2026-09-01T00:00:00.000Z" }),
        overrides: { propertyCap: null, trialEndsAt: "2026-12-24", complimentary: false },
      }),
    );
    expect(row.trialEndsAt).toBe("2026-12-24");
    expect(row.trialEndIsOverride).toBe(true);
  });

  it("carries complimentary through untouched — nothing else reads it yet", () => {
    const row = deriveAdminBillingRow(
      input({ overrides: { propertyCap: null, trialEndsAt: null, complimentary: true } }),
    );
    expect(row.complimentary).toBe(true);
    // It changes no plan, no cap and no fee: recorded and shown only.
    expect(row.tier).toBe("free");
    expect(row.propertyLimit).toBe(FREE_MAX_PROPERTIES);
  });
});

describe("who pays processing", () => {
  it("free plan forces the resident, whatever the manager chose", () => {
    const row = deriveAdminBillingRow(input({ managerFeeChoice: "proplane" }));
    expect(row.serviceFeePayer).toBe("resident");
    expect(row.proplaneAbsorbsFees).toBe(false);
  });

  it("a staff override wins and files the row under Absorbing fees", () => {
    const row = deriveAdminBillingRow(input({ adminFeeOverride: "proplane" }));
    expect(row.serviceFeePayer).toBe("proplane");
    expect(row.proplaneAbsorbsFees).toBe(true);
    expect(row.feeOverrideSetByStaff).toBe(true);
    expect(adminBillingRowMatchesTab(row, "absorbing")).toBe(true);
  });
});

describe("communication allowance", () => {
  it("reports usage against the plan's included amount", () => {
    const row = deriveAdminBillingRow(
      input({
        purchase: purchase({ tier: "pro", stripeSubscriptionId: "sub_1" }),
        commsUsedCents: 400,
      }),
    );
    expect(row.comms).toMatchObject({ tier: "pro", usedCents: 400, allowanceCents: 1000, exhausted: false });
  });

  it("shows nothing rather than a wrong zero when usage could not be read", () => {
    const row = deriveAdminBillingRow(input({ commsUsedCents: null }));
    expect(row.comms).toBeNull();
  });
});

describe("tabs", () => {
  it("only honours a real tab id from the URL", () => {
    expect(adminBillingTabFromParam("pro")).toBe("pro");
    expect(adminBillingTabFromParam("PRO")).toBe("pro");
    expect(adminBillingTabFromParam("nonsense")).toBe("all");
    expect(adminBillingTabFromParam(null)).toBe("all");
  });

  it("counts every row under All and each row under the tabs it belongs to", () => {
    const rows = [
      deriveAdminBillingRow(input({ id: "a" })),
      deriveAdminBillingRow(input({ id: "b", planReadFailed: true })),
      deriveAdminBillingRow(input({ id: "c", adminFeeOverride: "proplane" })),
      deriveAdminBillingRow(
        input({ id: "d", purchase: purchase({ tier: "business", stripeSubscriptionId: "sub_1" }) }),
      ),
    ];
    const counts = adminBillingTabCounts(rows);
    expect(counts.all).toBe(4);
    expect(counts.free).toBe(2);
    expect(counts.business).toBe(1);
    // Two: the staff-overridden row AND the Business account that has made no choice of its own —
    // `resolveServiceFeePayerFor`'s default for a paid plan IS `proplane`. The tab reports the net
    // answer, not "staff pushed a button", which is the point of reading it from that resolver.
    expect(counts.absorbing).toBe(1);
    expect(ADMIN_BILLING_TABS.map((t) => t.id)).toEqual([
      "all",
      "trial",
      "free",
      "pro",
      "business",
      "absorbing",
    ]);
  });
});
