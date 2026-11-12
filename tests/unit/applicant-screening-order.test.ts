import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({
  createBackgroundCheck: vi.fn(),
  tier: vi.fn(),
  recordAutoExpense: vi.fn(),
  refund: vi.fn(),
}));
vi.mock("@/lib/checkr/client", () => ({
  createBackgroundCheck: h.createBackgroundCheck,
  fetchBackgroundCheckReport: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getManagerSubscriptionTier: h.tier, getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/reports/auto-expense", () => ({ recordAutoExpense: h.recordAutoExpense }));
vi.mock("@/lib/security/applicant-identity", () => ({ openApplicantRow: (row: unknown) => row, sealApplicantRow: (row: unknown) => row }));
vi.mock("@/lib/security/cosigner-repository", () => ({ loadOwnedCosignerRecord: vi.fn(), persistOwnedCosignerRecord: vi.fn() }));
vi.mock("@/lib/screening/charge-manager", () => ({ chargeManagerForScreening: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: h.refund } }) }));

import { runBackgroundCheck } from "@/lib/checkr/background-check";
import { screeningOrderOptionsFromSession } from "@/lib/stripe-screening";
import type Stripe from "stripe";

type Row = Record<string, unknown>;
function fakeDb(initial: Row) {
  const state = { application: initial, orders: [] as Row[] };
  const db = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "manager_application_records"
                ? { data: { id: state.application.id, manager_user_id: "mgr-1", row_data: state.application }, error: null }
                : { data: null, error: null },
          }),
        }),
        insert: async (row: Row) => {
          if (table === "screening_orders") state.orders.push(row);
          return { error: null };
        },
        upsert: async (row: Row) => {
          if (table === "manager_application_records") state.application = row.row_data as Row;
          if (table === "screening_orders") state.orders.push(row);
          return { error: null };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, state };
}

const application = { fullLegalName: "Jane Doe", email: "jane@example.com", dateOfBirth: "1990-01-01", ssn: "111223334", consentCredit: false };
const baseRow = (extra: Row = {}): Row => ({ id: "app-1", managerUserId: "mgr-1", email: "jane@example.com", application, ...extra });
const authorization = { disclosureVersion: "v1", authorizedAt: "2026-11-12T00:00:00.000Z" };
const created = (extra: Row = {}) => ({
  applicantId: "ap_1",
  orderId: "ord_1",
  packageSlug: "starter",
  addOnProducts: ["identity_verification"],
  status: "pending",
  result: null,
  simulated: false,
  ...extra,
});

beforeEach(() => {
  process.env.CHECKR_API_KEY = "ckr_sk_test_x";
  h.createBackgroundCheck.mockReset();
  h.tier.mockReset().mockResolvedValue("free");
  h.recordAutoExpense.mockReset();
  h.refund.mockReset();
});
afterEach(() => {
  delete process.env.CHECKR_API_KEY;
});

describe("applicant-paid order placement", () => {
  it("places a Starter + ID order for a free-plan manager, with the applicant's authorization and no manager expense", async () => {
    const { db, state } = fakeDb(baseRow());
    h.createBackgroundCheck.mockResolvedValue(created());
    const result = await runBackgroundCheck({
      db,
      applicationId: "app-1",
      managerUserId: "mgr-1",
      packageSlug: "starter",
      addOnProducts: ["identity_verification"],
      prepaid: { checkoutSessionId: "cs_1", paymentIntentId: "pi_1" },
      payer: "applicant",
      authorization,
    });
    expect(result.ok).toBe(true);
    expect(h.tier).not.toHaveBeenCalled();
    expect(h.createBackgroundCheck.mock.calls[0][2]).toEqual({ packageSlug: "starter", addOnProducts: ["identity_verification"] });
    const bc = (state.application as { backgroundCheck: Record<string, unknown> }).backgroundCheck;
    expect(bc).toMatchObject({ payer: "applicant", authorization, costCents: 2794, stripeCheckoutSessionId: "cs_1", packageSlug: "starter" });
    expect(h.recordAutoExpense).not.toHaveBeenCalled();
  });

  it("refuses an applicant-paid order with no authorization (and never reaches Checkr)", async () => {
    const { db } = fakeDb(baseRow());
    const result = await runBackgroundCheck({ db, applicationId: "app-1", managerUserId: "mgr-1", payer: "applicant", prepaid: { checkoutSessionId: "cs_2" } });
    expect(result).toMatchObject({ ok: false, code: "authorization_required" });
    expect(h.createBackgroundCheck).not.toHaveBeenCalled();
  });

  it("is idempotent on the Checkout session (a webhook redelivery never orders twice)", async () => {
    const { db } = fakeDb(baseRow());
    h.createBackgroundCheck.mockResolvedValue(created());
    const opts = { db, applicationId: "app-1", managerUserId: "mgr-1", packageSlug: "starter", payer: "applicant" as const, authorization, prepaid: { checkoutSessionId: "cs_3" } };
    expect((await runBackgroundCheck(opts)).ok).toBe(true);
    expect((await runBackgroundCheck(opts)).ok).toBe(true);
    expect(h.createBackgroundCheck).toHaveBeenCalledTimes(1);
  });

  it("refuses a second paid session for an application that already has a check", async () => {
    const existing = { provider: "checkr", candidateId: "a", reportId: "ord_0", packageSlug: "starter", status: "pending", result: null, orderedAt: "2026-11-01T00:00:00.000Z", stripeCheckoutSessionId: "cs_old" };
    const { db } = fakeDb(baseRow({ backgroundCheck: existing }));
    const result = await runBackgroundCheck({ db, applicationId: "app-1", managerUserId: "mgr-1", payer: "applicant", authorization, prepaid: { checkoutSessionId: "cs_new" } });
    expect(result.ok).toBe(false);
    expect(h.createBackgroundCheck).not.toHaveBeenCalled();
  });
});

describe("manager upgrade of an applicant-paid check", () => {
  const completed = {
    provider: "checkr",
    candidateId: "ap_1",
    reportId: "ord_1",
    packageSlug: "starter",
    addOnProducts: ["identity_verification"],
    status: "complete",
    result: "clear",
    orderedAt: "2026-11-01T00:00:00.000Z",
    reportSnapshot: { identity_verification: { status: "clear" } },
    payer: "applicant",
    authorization,
    costCents: 2794,
  };

  beforeEach(() => h.tier.mockResolvedValue("pro"));

  it("orders the higher package, records only the difference, and carries the ID result instead of re-buying it", async () => {
    const { db, state } = fakeDb(baseRow({ backgroundCheck: completed }));
    h.createBackgroundCheck.mockResolvedValue(created({ orderId: "ord_2", packageSlug: "essential", addOnProducts: [] }));
    const result = await runBackgroundCheck({
      db,
      applicationId: "app-1",
      managerUserId: "mgr-1",
      packageSlug: "essential",
      addOnProducts: ["identity_verification"],
      upgradeFrom: "starter",
      prepaid: { checkoutSessionId: "cs_up" },
    });
    expect(result.ok).toBe(true);
    expect(h.createBackgroundCheck.mock.calls[0][2]).toEqual({ packageSlug: "essential", addOnProducts: [] });
    const bc = (state.application as { backgroundCheck: Record<string, unknown> }).backgroundCheck;
    expect(bc).toMatchObject({
      packageSlug: "essential",
      costCents: 1000,
      upgradedFrom: { packageSlug: "starter", reportId: "ord_1" },
      carriedIdentity: { status: "clear", orderId: "ord_1" },
    });
  });

  it("refuses an upgrade that does not match the current check (the caller refunds)", async () => {
    const { db } = fakeDb(baseRow({ backgroundCheck: { ...completed, packageSlug: "essential" } }));
    const result = await runBackgroundCheck({ db, applicationId: "app-1", managerUserId: "mgr-1", packageSlug: "complete", upgradeFrom: "starter", prepaid: { checkoutSessionId: "cs_bad" } });
    expect(result).toMatchObject({ ok: false, code: "upgrade_mismatch" });
    expect(h.createBackgroundCheck).not.toHaveBeenCalled();
  });
});

describe("what a paid session says about the order", () => {
  const session = (metadata: Record<string, string>) => ({ metadata }) as unknown as Stripe.Checkout.Session;
  it("reads payer, authorization and upgrade only from the session metadata our routes wrote", () => {
    expect(
      screeningOrderOptionsFromSession(session({ payer: "applicant", fcra_authorized_at: "t", fcra_disclosure_version: "v", upgrade_from_package: "starter" })),
    ).toEqual({ payer: "applicant", authorization: { authorizedAt: "t", disclosureVersion: "v" }, upgradeFrom: "starter" });
    expect(screeningOrderOptionsFromSession(session({ payer: "applicant" }))).toEqual({ payer: "applicant" });
    expect(screeningOrderOptionsFromSession(session({ upgrade_from_package: "bogus" }))).toEqual({});
    expect(screeningOrderOptionsFromSession(session({}))).toEqual({});
  });
});
