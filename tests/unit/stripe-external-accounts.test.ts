import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  addFromFinancialConnections,
  addPayoutDestination,
  createFinancialConnectionsSession,
  listPayoutDestinations,
  refreshPayoutDestinationsCacheFromStripe,
  removePayoutDestination,
  replacePayoutDestinationsCache,
  setDefaultPayoutDestination,
  validateAddBankAccountRequestBody,
  validateFinancialConnectionsAttachRequestBody,
  validateVerifyMicroDepositsRequestBody,
  verifyPayoutDestinationMicroDeposits,
} from "@/lib/stripe-external-accounts.server";

type Row = Record<string, unknown>;

/** Minimal in-memory fake covering the two tables this module touches. */
function makeFakeDb() {
  const tables: Record<string, Row[]> = { payout_destinations_cache: [], stripe_payouts: [] };

  function chain(table: string, mode: "select" | "delete") {
    const filters: Array<(r: Row) => boolean> = [];
    let limit: number | null = null;
    const builder: Record<string, unknown> = {
      eq(col: string, value: unknown) {
        filters.push((r) => r[col] === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        filters.push((r) => values.includes(r[col]));
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
        const rows = tables[table] ?? [];
        let matched = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "delete") {
          for (const r of matched) rows.splice(rows.indexOf(r), 1);
        }
        if (limit != null) matched = matched.slice(0, limit);
        return Promise.resolve(resolve({ data: matched, error: null }));
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select: () => chain(table, "select"),
        delete: () => chain(table, "delete"),
        insert: (rows: Row | Row[]) => {
          const list = Array.isArray(rows) ? rows : [rows];
          (tables[table] ??= []).push(...list);
          return Promise.resolve({ data: list, error: null });
        },
      };
    },
  };
  return { client, tables };
}

function makeFakeStripe(overrides: Partial<Stripe> = {}): Stripe {
  return {
    accounts: {
      retrieve: vi.fn(),
      createExternalAccount: vi.fn(),
      updateExternalAccount: vi.fn(),
      deleteExternalAccount: vi.fn().mockResolvedValue({ deleted: true }),
    },
    financialConnections: {
      sessions: {
        create: vi.fn(),
      },
    },
    rawRequest: vi.fn(),
    ...overrides,
  } as unknown as Stripe;
}

const bankAccount = (over: Partial<Stripe.BankAccount> = {}): Stripe.BankAccount =>
  ({
    id: "ba_1",
    object: "bank_account",
    bank_name: "Chase",
    last4: "4321",
    status: "new",
    default_for_currency: false,
    ...over,
  }) as Stripe.BankAccount;

const card = (over: Partial<Stripe.Card> = {}): Stripe.Card =>
  ({
    id: "card_1",
    object: "card",
    brand: "Visa",
    last4: "4242",
    funding: "debit",
    default_for_currency: false,
    ...over,
  }) as Stripe.Card;

describe("listPayoutDestinations", () => {
  it("maps bank accounts and cards, never including full numbers", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "acct_1",
      external_accounts: { data: [bankAccount({ status: "verified", default_for_currency: true }), card()] },
    });

    const destinations = await listPayoutDestinations(stripe, "acct_1");
    expect(destinations).toEqual([
      { id: "ba_1", kind: "bank", label: "Chase", last4: "4321", status: "verified", default: true },
      { id: "card_1", kind: "card", label: "Visa", last4: "4242", status: "verified", default: false },
    ]);
    const serialized = JSON.stringify(destinations);
    // Only last4 digits ever appear — no full account/card number field exists on the shape.
    expect(serialized).not.toMatch(/\d{6,}/);
  });

  it("maps a bank account's errored/verifying states", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "acct_1",
      external_accounts: { data: [bankAccount({ id: "ba_2", status: "errored" }), bankAccount({ id: "ba_3", status: "validated" })] },
    });
    const destinations = await listPayoutDestinations(stripe, "acct_1");
    expect(destinations.map((d) => d.status)).toEqual(["errored", "verifying"]);
  });
});

describe("addPayoutDestination", () => {
  it("adds a bank token", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockResolvedValue(bankAccount());
    const result = await addPayoutDestination(stripe, "acct_1", { token: "btok_123" });
    expect(result).toMatchObject({ ok: true, destination: { kind: "bank", last4: "4321" } });
    expect(stripe.accounts.createExternalAccount).toHaveBeenCalledWith("acct_1", { external_account: "btok_123" });
  });

  it("adds a debit card", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockResolvedValue(card());
    const result = await addPayoutDestination(stripe, "acct_1", { token: "tok_123" });
    expect(result).toMatchObject({ ok: true, destination: { kind: "card", last4: "4242" } });
  });

  it("rejects a credit card and removes what was just attached", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockResolvedValue(card({ funding: "credit" }));
    const result = await addPayoutDestination(stripe, "acct_1", { token: "tok_credit" });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(stripe.accounts.deleteExternalAccount).toHaveBeenCalledWith("acct_1", "card_1");
  });

  it("422s an empty token without calling Stripe", async () => {
    const stripe = makeFakeStripe();
    const result = await addPayoutDestination(stripe, "acct_1", { token: "  " });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(stripe.accounts.createExternalAccount).not.toHaveBeenCalled();
  });

  it("400s a Stripe validation failure and passes its message through", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Invalid bank account number."),
    );
    const result = await addPayoutDestination(stripe, "acct_1", { token: "btok_bad" });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid bank account number." });
  });

  it("swaps a Connect-account-access leak for a generic message and logs the real one", async () => {
    const stripe = makeFakeStripe();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("This API key does not have access to account acct_1 (or that account does not exist)."),
    );
    const result = await addPayoutDestination(stripe, "acct_1", { token: "btok_1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("acct_1");
      expect(result.error).not.toContain("does not have access");
    }
    expect(consoleErrorSpy.mock.calls.some((c) => c.some((a) => String(a).includes("acct_1")))).toBe(true);
    consoleErrorSpy.mockRestore();
  });
});

describe("addFromFinancialConnections", () => {
  it("passes the Financial Connections account id straight through as external_account", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.createExternalAccount as ReturnType<typeof vi.fn>).mockResolvedValue(bankAccount({ id: "ba_fc" }));
    const result = await addFromFinancialConnections(stripe, "acct_1", { financialConnectionsAccountId: "fca_1" });
    expect(result.ok).toBe(true);
    expect(stripe.accounts.createExternalAccount).toHaveBeenCalledWith("acct_1", { external_account: "fca_1" });
  });
});

describe("createFinancialConnectionsSession", () => {
  it("scopes the session to the connected account itself, payment_method only", async () => {
    const stripe = makeFakeStripe();
    (stripe.financialConnections.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fcsess_1",
      client_secret: "secret_1",
    });
    const session = await createFinancialConnectionsSession(stripe, "acct_1");
    expect(session).toEqual({ clientSecret: "secret_1", sessionId: "fcsess_1" });
    expect(stripe.financialConnections.sessions.create).toHaveBeenCalledWith({
      account_holder: { type: "account", account: "acct_1" },
      permissions: ["payment_method"],
      filters: { countries: ["US"] },
    });
  });
});

describe("setDefaultPayoutDestination", () => {
  it("sets default_for_currency", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.updateExternalAccount as ReturnType<typeof vi.fn>).mockResolvedValue(
      bankAccount({ default_for_currency: true }),
    );
    const result = await setDefaultPayoutDestination(stripe, "acct_1", "ba_1");
    expect(result).toMatchObject({ ok: true, destination: { default: true } });
    expect(stripe.accounts.updateExternalAccount).toHaveBeenCalledWith("acct_1", "ba_1", { default_for_currency: true });
  });
});

describe("removePayoutDestination", () => {
  let fakeDb: ReturnType<typeof makeFakeDb>;
  beforeEach(() => {
    fakeDb = makeFakeDb();
  });

  it("removes freely when it is not the only destination", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      external_accounts: { data: [bankAccount(), card()] },
    });
    const result = await removePayoutDestination(stripe, fakeDb.client as never, "acct_1", "ba_1");
    expect(result).toEqual({ ok: true });
    expect(stripe.accounts.deleteExternalAccount).toHaveBeenCalledWith("acct_1", "ba_1");
  });

  it("409s removing the ONLY destination while a payout is pending", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      external_accounts: { data: [bankAccount()] },
    });
    fakeDb.tables.stripe_payouts.push({ id: "p1", stripe_connect_account_id: "acct_1", status: "pending" });

    const result = await removePayoutDestination(stripe, fakeDb.client as never, "acct_1", "ba_1");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(stripe.accounts.deleteExternalAccount).not.toHaveBeenCalled();
  });

  it("allows removing the only destination when nothing is pending", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      external_accounts: { data: [bankAccount()] },
    });
    const result = await removePayoutDestination(stripe, fakeDb.client as never, "acct_1", "ba_1");
    expect(result).toEqual({ ok: true });
  });
});

describe("verifyPayoutDestinationMicroDeposits", () => {
  it("posts amounts to the raw verify endpoint", async () => {
    const stripe = makeFakeStripe();
    (stripe.rawRequest as ReturnType<typeof vi.fn>).mockResolvedValue(bankAccount({ status: "verified" }));
    const result = await verifyPayoutDestinationMicroDeposits(stripe, "acct_1", "ba_1", [32, 45]);
    expect(result).toMatchObject({ ok: true, destination: { status: "verified" } });
    expect(stripe.rawRequest).toHaveBeenCalledWith("POST", "/v1/accounts/acct_1/external_accounts/ba_1/verify", {
      amounts: [32, 45],
    });
  });
});

describe("request body validation", () => {
  it("validateAddBankAccountRequestBody requires a non-empty token", () => {
    expect(validateAddBankAccountRequestBody({ token: "btok_1" })).toEqual({ ok: true, input: { token: "btok_1" } });
    expect(validateAddBankAccountRequestBody({ token: "" }).ok).toBe(false);
    expect(validateAddBankAccountRequestBody(null).ok).toBe(false);
  });

  it("validateFinancialConnectionsAttachRequestBody requires accountId", () => {
    expect(validateFinancialConnectionsAttachRequestBody({ accountId: "fca_1" })).toEqual({
      ok: true,
      input: { financialConnectionsAccountId: "fca_1" },
    });
    expect(validateFinancialConnectionsAttachRequestBody({}).ok).toBe(false);
  });

  it("validateVerifyMicroDepositsRequestBody requires two positive integer cents", () => {
    expect(validateVerifyMicroDepositsRequestBody({ amounts: [32, 45] })).toEqual({ ok: true, input: { amounts: [32, 45] } });
    expect(validateVerifyMicroDepositsRequestBody({ amounts: [32] }).ok).toBe(false);
    expect(validateVerifyMicroDepositsRequestBody({ amounts: [0, 45] }).ok).toBe(false);
    expect(validateVerifyMicroDepositsRequestBody({ amounts: ["a", "b"] }).ok).toBe(false);
  });
});

describe("payout destinations cache", () => {
  let fakeDb: ReturnType<typeof makeFakeDb>;
  beforeEach(() => {
    fakeDb = makeFakeDb();
  });

  it("replaces every cached row for the owner", async () => {
    fakeDb.tables.payout_destinations_cache.push({ owner_user_id: "owner-1", stripe_external_account_id: "old" });
    await replacePayoutDestinationsCache(fakeDb.client as never, "owner-1", [
      { id: "ba_1", kind: "bank", label: "Chase", last4: "4321", status: "verified", default: true },
    ]);
    expect(fakeDb.tables.payout_destinations_cache).toHaveLength(1);
    expect(fakeDb.tables.payout_destinations_cache[0]).toMatchObject({
      owner_user_id: "owner-1",
      stripe_external_account_id: "ba_1",
      kind: "bank",
      last4: "4321",
      is_default: true,
    });
  });

  it("clears the cache when there are no destinations left", async () => {
    fakeDb.tables.payout_destinations_cache.push({ owner_user_id: "owner-1", stripe_external_account_id: "old" });
    await replacePayoutDestinationsCache(fakeDb.client as never, "owner-1", []);
    expect(fakeDb.tables.payout_destinations_cache).toHaveLength(0);
  });

  it("refreshPayoutDestinationsCacheFromStripe reads live and writes the cache in one step", async () => {
    const stripe = makeFakeStripe();
    (stripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      external_accounts: { data: [bankAccount({ status: "verified" })] },
    });
    const destinations = await refreshPayoutDestinationsCacheFromStripe(stripe, fakeDb.client as never, "owner-1", "acct_1");
    expect(destinations).toHaveLength(1);
    expect(fakeDb.tables.payout_destinations_cache).toHaveLength(1);
  });
});
