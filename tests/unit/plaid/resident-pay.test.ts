import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const state = vi.hoisted(() => ({
  user: { id: "resident-1" } as { id: string } | null,
  residentRole: true,
  testWorkspace: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { role: "resident" }, error: null }) };
      return q;
    },
  }),
}));
const roleCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: roleCheck }));
vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext: vi.fn(), assertManagerFinancialsAccess: vi.fn() }));
vi.mock("@/lib/test-workspaces/effects.server", () => {
  class TestWorkspaceProviderDisabledError extends Error {}
  return {
    TestWorkspaceProviderDisabledError,
    assertTestWorkspaceProviderEffectAllowed: async () => {
      if (state.testWorkspace) throw new TestWorkspaceProviderDisabledError("test");
    },
  };
});

import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { PLAID_ENABLED_PURPOSES } from "@/lib/plaid/client.server";
import { attachPlaidBankToStripeCustomer } from "@/lib/plaid/stripe-processor.server";
import { payManualAchWithPlaidBank } from "@/lib/plaid/resident-pay.server";
import { createPlaidItem } from "@/lib/plaid/items.server";
import { createFakeDb } from "./fake-db";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "test";
  process.env.DATA_ENCRYPTION_KEYS_JSON = JSON.stringify({ test: randomBytes(32).toString("base64") });
});

beforeEach(() => {
  state.user = { id: "resident-1" };
  state.residentRole = true;
  state.testWorkspace = false;
  roleCheck.mockReset();
  roleCheck.mockImplementation(async () => state.residentRole);
  process.env.PLAID_CLIENT_ID = "cid";
  process.env.PLAID_SECRET = "secret";
  process.env.PLAID_ENV = "sandbox";
});

describe("resident_pay authorization", () => {
  it("is an enabled purpose", () => {
    expect(PLAID_ENABLED_PURPOSES).toContain("resident_pay");
  });

  it("takes the owner from the session and checks the resident role with it", async () => {
    const actor = await authorizePlaidPurpose("resident_pay");
    expect(actor).toMatchObject({ ok: true, userId: "resident-1" });
    expect(roleCheck).toHaveBeenCalledWith(expect.anything(), { userId: "resident-1", legacyRole: "resident" });
  });

  it("refuses a non-resident with 403 and a signed-out caller with 401", async () => {
    state.residentRole = false;
    expect(await authorizePlaidPurpose("resident_pay")).toMatchObject({ ok: false, status: 403 });
    state.user = null;
    expect(await authorizePlaidPurpose("resident_pay")).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses a test workspace after the role check, and answers 404 when Plaid is disabled", async () => {
    state.testWorkspace = true;
    expect(await authorizePlaidPurpose("resident_pay")).toMatchObject({ ok: false, status: 403 });
    state.testWorkspace = false;
    delete process.env.PLAID_SECRET;
    expect(await authorizePlaidPurpose("resident_pay")).toMatchObject({ ok: false, status: 404 });
  });
});

function plaidMock() {
  return { processorStripeBankAccountTokenCreate: vi.fn(async () => ({ data: { stripe_bank_account_token: "btok_123" } })) };
}
function stripeMock(existing: Array<Record<string, unknown>> = []) {
  return {
    tokens: { retrieve: vi.fn(async () => ({ bank_account: { fingerprint: "fp_1" } })) },
    customers: {
      listSources: vi.fn(async () => ({ data: existing })),
      createSource: vi.fn(async () => ({ id: "ba_new", object: "bank_account", status: "verified" })),
    },
    paymentIntents: {
      retrieve: vi.fn(async () => ({ id: "pi_1", status: "requires_payment_method", customer: null })),
      update: vi.fn(async () => ({})),
      confirm: vi.fn(async () => ({})),
    },
  };
}

async function seedItem(overrides: Record<string, unknown> = {}) {
  const { db } = createFakeDb();
  const row = await createPlaidItem(db, {
    ownerUserId: "resident-1", purpose: "resident_pay", itemId: "plaid-item-1",
    accessToken: "access-sandbox-secret", plaidAccountId: "acc-1", accountMask: "0000", institutionName: "First Platypus Bank",
    ...overrides,
  });
  return { db, row };
}

describe("attachPlaidBankToStripeCustomer", () => {
  it("mints the Stripe bank token for the linked account and adds a verified bank to the customer", async () => {
    const { row } = await seedItem();
    const plaid = plaidMock();
    const stripe = stripeMock();
    const result = await attachPlaidBankToStripeCustomer({ plaid: plaid as never, stripe: stripe as never }, { item: row, stripeCustomerId: "cus_1" });
    expect(result).toEqual({ bankAccountId: "ba_new", reused: false });
    expect(plaid.processorStripeBankAccountTokenCreate).toHaveBeenCalledWith({ access_token: "access-sandbox-secret", account_id: "acc-1" });
    expect(stripe.customers.createSource).toHaveBeenCalledWith("cus_1", { source: "btok_123" });
  });

  it("reuses a verified bank with the same fingerprint instead of adding a duplicate", async () => {
    const { row } = await seedItem();
    const stripe = stripeMock([{ id: "ba_old", object: "bank_account", fingerprint: "fp_1", status: "verified" }]);
    const result = await attachPlaidBankToStripeCustomer({ plaid: plaidMock() as never, stripe: stripe as never }, { item: row, stripeCustomerId: "cus_1" });
    expect(result).toEqual({ bankAccountId: "ba_old", reused: true });
    expect(stripe.customers.createSource).not.toHaveBeenCalled();
  });

  it("refuses an item with no shared account and a bank Stripe does not call verified", async () => {
    const { row } = await seedItem({ plaidAccountId: null });
    await expect(attachPlaidBankToStripeCustomer({ plaid: plaidMock() as never, stripe: stripeMock() as never }, { item: row, stripeCustomerId: "cus_1" })).rejects.toThrow();
    const { row: row2 } = await seedItem({ itemId: "plaid-item-2" });
    const stripe = stripeMock();
    stripe.customers.createSource.mockResolvedValueOnce({ id: "ba_x", object: "bank_account", status: "new" });
    await expect(attachPlaidBankToStripeCustomer({ plaid: plaidMock() as never, stripe: stripe as never }, { item: row2, stripeCustomerId: "cus_1" })).rejects.toThrow(/verified/);
  });
});

describe("payManualAchWithPlaidBank", () => {
  const input = { userId: "resident-1", stripeCustomerId: "cus_1", paymentIntentId: "pi_1", plaidItemId: "row", authorized: true, ip: "1.2.3.4", userAgent: "ua" };

  async function deps(stripe = stripeMock(), assertAttempt = vi.fn(async () => ({}))) {
    const { db, row } = await seedItem();
    return { d: { db, plaid: plaidMock() as never, stripe: stripe as never, assertAttempt, loadItem: vi.fn(async () => row) as never }, stripe, assertAttempt };
  }

  it("confirms the existing PaymentIntent with the Plaid bank and the one-time mandate", async () => {
    const { d, stripe, assertAttempt } = await deps();
    expect(await payManualAchWithPlaidBank(d, input)).toEqual({ ok: true });
    expect(assertAttempt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "pi_1" }), "resident-1");
    expect(stripe.paymentIntents.update).toHaveBeenCalledWith("pi_1", expect.objectContaining({ customer: "cus_1" }));
    expect(stripe.paymentIntents.confirm).toHaveBeenCalledWith("pi_1", {
      payment_method: "ba_new",
      mandate_data: { customer_acceptance: { type: "online", online: { ip_address: "1.2.3.4", user_agent: "ua" } } },
    });
  });

  it("refuses without the debit authorization, before any provider call", async () => {
    const { d, stripe } = await deps();
    expect(await payManualAchWithPlaidBank(d, { ...input, authorized: false })).toMatchObject({ ok: false, status: 400 });
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("refuses an item that is not this resident's resident_pay item", async () => {
    const { d } = await deps();
    const wrongPurpose = { ...d, loadItem: vi.fn(async () => ({ purpose: "bank_feed", status: "active" })) as never };
    expect(await payManualAchWithPlaidBank(wrongPurpose, input)).toMatchObject({ ok: false, status: 404 });
    const missing = { ...d, loadItem: vi.fn(async () => null) as never };
    expect(await payManualAchWithPlaidBank(missing, input)).toMatchObject({ ok: false, status: 404 });
    expect(d.loadItem).not.toHaveBeenCalled();
  });

  it("scopes the item lookup to the session user, not the body", async () => {
    const { d } = await deps();
    await payManualAchWithPlaidBank(d, input);
    expect(d.loadItem).toHaveBeenCalledWith(expect.anything(), "resident-1", "row");
  });

  it("refuses another resident's attempt and a PaymentIntent that already has a bank", async () => {
    const stripe = stripeMock();
    const { d } = await deps(stripe, vi.fn(async () => { throw new Error("This bank payment does not belong to your account."); }));
    await expect(payManualAchWithPlaidBank(d, input)).rejects.toThrow(/does not belong/);
    expect(stripe.paymentIntents.confirm).not.toHaveBeenCalled();

    const busy = stripeMock();
    busy.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_1", status: "requires_action", customer: null } as never);
    const { d: d2 } = await deps(busy);
    expect(await payManualAchWithPlaidBank(d2, input)).toMatchObject({ ok: false, status: 409 });
    expect(busy.customers.createSource).not.toHaveBeenCalled();
  });

  it("refuses a PaymentIntent attached to a different Stripe customer", async () => {
    const stripe = stripeMock();
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_1", status: "requires_payment_method", customer: "cus_other" } as never);
    const { d } = await deps(stripe);
    expect(await payManualAchWithPlaidBank(d, input)).toMatchObject({ ok: false, status: 403 });
    expect(stripe.customers.createSource).not.toHaveBeenCalled();
  });
});
