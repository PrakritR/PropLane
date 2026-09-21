import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * End-to-end route tests for the payouts bank-accounts surface (PLAN-0920-1500
 * part B) against a fake Stripe client and a fake Supabase table, mirroring
 * `tests/unit/stripe-payouts-route.test.ts`'s pattern: only the auth/ACL
 * layers and the Stripe/DB clients are mocked, so the real
 * `stripe-external-accounts.server.ts` logic runs underneath every assertion.
 */

const payoutContext: {
  payoutOwnerUserId: string;
  canEditBankAccount: boolean;
  isCoManagerForPayout: boolean;
  unresolvedReason?: string;
} = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  isCoManagerForPayout: false,
};

vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payoutContext,
  stripePayoutContextError: () => "unresolved",
}));

vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async (
    _db: unknown,
    _userId: string,
    ownerId: string | null | undefined,
    level: "read" | "edit",
  ) => {
    if (!ownerId || ownerId === "caller-1") return { ok: true };
    if (level === "read") return { ok: true };
    if (payoutContext.canEditBankAccount) return { ok: true };
    return { ok: false, status: 403 as const, error: "You do not have permission to change this account's bank details." };
  },
}));

let sessionUser: { id: string } | null = { id: "caller-1" };
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));

type Row = Record<string, unknown>;

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
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
        const rows = tables[table] ?? [];
        let matched = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "delete") for (const r of matched) rows.splice(rows.indexOf(r), 1);
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

let fakeDb = makeFakeDb();
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => fakeDb.client,
}));

const bankAccount = (over: Partial<Stripe.BankAccount> = {}): Stripe.BankAccount =>
  ({ id: "ba_1", object: "bank_account", bank_name: "Chase", last4: "4321", status: "new", default_for_currency: false, ...over }) as Stripe.BankAccount;

function makeFakeStripe(externalAccounts: Stripe.ExternalAccount[] = [bankAccount()]) {
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue({ id: "acct_owner", external_accounts: { data: externalAccounts } }),
      createExternalAccount: vi.fn().mockResolvedValue(bankAccount({ id: "ba_new" })),
      updateExternalAccount: vi.fn().mockResolvedValue(bankAccount({ default_for_currency: true })),
      deleteExternalAccount: vi.fn().mockResolvedValue({ id: "ba_1", deleted: true }),
    },
    financialConnections: {
      sessions: { create: vi.fn().mockResolvedValue({ id: "fcsess_1", client_secret: "secret_1" }) },
    },
    rawRequest: vi.fn(),
  } as unknown as Stripe;
}

let fakeStripe = makeFakeStripe();
vi.mock("@/lib/stripe", () => ({ getStripe: () => fakeStripe }));

let connectAccountId: string | null = "acct_owner";
vi.mock("@/lib/stripe-connect", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-connect")>("@/lib/stripe-connect");
  return { ...actual, resolveManagerConnectAccountId: async () => connectAccountId };
});

let vendorAccess: { ok: true; actor: { userId: string; email: string } } | { ok: false; status: 401 | 403 } = {
  ok: true,
  actor: { userId: "vendor-1", email: "vendor@example.com" },
};
vi.mock("@/lib/auth/vendor-api-access", () => ({
  requireVendorApiAccess: async () => vendorAccess,
}));

import { GET as managerGet, POST as managerPost } from "@/app/api/stripe/connect/bank-accounts/route";
import { DELETE as managerDelete, PATCH as managerPatch } from "@/app/api/stripe/connect/bank-accounts/[id]/route";
import { POST as fcSessionPost } from "@/app/api/stripe/connect/financial-connections/session/route";
import { GET as vendorGet, POST as vendorPost } from "@/app/api/vendor/stripe-connect/bank-accounts/route";
import { DELETE as vendorDelete, PATCH as vendorPatch } from "@/app/api/vendor/stripe-connect/bank-accounts/[id]/route";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, { method, body: JSON.stringify(body) });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = { id: "caller-1" };
  connectAccountId = "acct_owner";
  payoutContext.payoutOwnerUserId = "owner-1";
  payoutContext.canEditBankAccount = true;
  payoutContext.isCoManagerForPayout = false;
  vendorAccess = { ok: true, actor: { userId: "vendor-1", email: "vendor@example.com" } };
  fakeDb = makeFakeDb();
  fakeStripe = makeFakeStripe();
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
});

describe("GET /api/stripe/connect/bank-accounts", () => {
  it("401s with no session", async () => {
    sessionUser = null;
    const res = await managerGet();
    expect(res.status).toBe(401);
  });

  it("returns [] with no Connect account yet, without calling Stripe", async () => {
    connectAccountId = null;
    const res = await managerGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ destinations: [] });
    expect(fakeStripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("lists live destinations and refreshes the cache", async () => {
    const res = await managerGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.destinations).toEqual([
      { id: "ba_1", kind: "bank", label: "Chase", last4: "4321", status: "verifying", default: false },
    ]);
    expect(fakeDb.tables.payout_destinations_cache).toHaveLength(1);
  });
});

describe("POST /api/stripe/connect/bank-accounts — add", () => {
  it("422s a missing token before touching Stripe", async () => {
    const res = await managerPost(jsonRequest("http://x/api/stripe/connect/bank-accounts", {}));
    expect(res.status).toBe(422);
    expect(fakeStripe.accounts.createExternalAccount).not.toHaveBeenCalled();
  });

  it("403s a co-manager without bank-edit permission — no add", async () => {
    payoutContext.isCoManagerForPayout = true;
    payoutContext.canEditBankAccount = false;
    payoutContext.payoutOwnerUserId = "owner-2";
    const res = await managerPost(jsonRequest("http://x/api/stripe/connect/bank-accounts", { token: "btok_1" }));
    expect(res.status).toBe(403);
    expect(fakeStripe.accounts.createExternalAccount).not.toHaveBeenCalled();
  });

  it("adds a bank account from a token id and refreshes the cache", async () => {
    const res = await managerPost(jsonRequest("http://x/api/stripe/connect/bank-accounts", { token: "btok_1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.destination).toMatchObject({ id: "ba_new", kind: "bank" });
    expect(fakeStripe.accounts.createExternalAccount).toHaveBeenCalledWith("acct_owner", { external_account: "btok_1" });
    expect(fakeDb.tables.payout_destinations_cache.length).toBeGreaterThan(0);
  });

  it("422s when no Connect account exists yet", async () => {
    connectAccountId = null;
    const res = await managerPost(jsonRequest("http://x/api/stripe/connect/bank-accounts", { token: "btok_1" }));
    expect(res.status).toBe(422);
    expect(fakeStripe.accounts.createExternalAccount).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/stripe/connect/bank-accounts/[id] — set default", () => {
  it("sets the destination as default", async () => {
    const res = await managerPatch(jsonRequest("http://x", {}, "PATCH"), ctxFor("ba_1"));
    expect(res.status).toBe(200);
    expect(fakeStripe.accounts.updateExternalAccount).toHaveBeenCalledWith("acct_owner", "ba_1", {
      default_for_currency: true,
    });
  });

  it("403s a read-only co-manager", async () => {
    payoutContext.isCoManagerForPayout = true;
    payoutContext.canEditBankAccount = false;
    payoutContext.payoutOwnerUserId = "owner-2";
    const res = await managerPatch(jsonRequest("http://x", {}, "PATCH"), ctxFor("ba_1"));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/stripe/connect/bank-accounts/[id] — remove", () => {
  it("removes freely when it is not the only destination", async () => {
    fakeStripe = makeFakeStripe([bankAccount(), bankAccount({ id: "ba_2" })]);
    const res = await managerDelete(jsonRequest("http://x", {}, "DELETE"), ctxFor("ba_1"));
    expect(res.status).toBe(200);
    expect(fakeStripe.accounts.deleteExternalAccount).toHaveBeenCalledWith("acct_owner", "ba_1");
  });

  it("409s removing the only destination while a payout is pending", async () => {
    fakeDb.tables.stripe_payouts.push({ id: "p1", stripe_connect_account_id: "acct_owner", status: "pending" });
    const res = await managerDelete(jsonRequest("http://x", {}, "DELETE"), ctxFor("ba_1"));
    expect(res.status).toBe(409);
    expect(fakeStripe.accounts.deleteExternalAccount).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/connect/financial-connections/session", () => {
  it("returns a client secret scoped to the manager's connected account", async () => {
    const res = await fcSessionPost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ clientSecret: "secret_1", publishableKey: "pk_test_123" });
    expect(fakeStripe.financialConnections.sessions.create).toHaveBeenCalledWith({
      account_holder: { type: "account", account: "acct_owner" },
      permissions: ["payment_method"],
      filters: { countries: ["US"] },
    });
  });

  it("503s when the publishable key is not configured", async () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    const res = await fcSessionPost();
    expect(res.status).toBe(503);
  });
});

describe("vendor twin — scoping", () => {
  it("401s with no vendor session", async () => {
    vendorAccess = { ok: false, status: 401 };
    const res = await vendorGet();
    expect(res.status).toBe(401);
  });

  it("403s a non-vendor caller", async () => {
    vendorAccess = { ok: false, status: 403 };
    const res = await vendorPost(jsonRequest("http://x", { token: "btok_1" }));
    expect(res.status).toBe(403);
  });

  it("scopes add to the vendor's own account id, ignoring a forged accountId in the body", async () => {
    const res = await vendorPost(jsonRequest("http://x", { token: "btok_1", accountId: "acct_forged" }));
    expect(res.status).toBe(200);
    expect(fakeStripe.accounts.createExternalAccount).toHaveBeenCalledWith("acct_owner", { external_account: "btok_1" });
  });

  it("scopes default/remove to the vendor's own connect account", async () => {
    const patchRes = await vendorPatch(jsonRequest("http://x", {}, "PATCH"), ctxFor("ba_1"));
    expect(patchRes.status).toBe(200);
    fakeStripe = makeFakeStripe([bankAccount(), bankAccount({ id: "ba_2" })]);
    const deleteRes = await vendorDelete(jsonRequest("http://x", {}, "DELETE"), ctxFor("ba_1"));
    expect(deleteRes.status).toBe(200);
  });
});

describe("Security review — a thrown Stripe error's own message never reaches the response body", () => {
  const stripeAccountLeak = () =>
    new Error("This API key does not have access to account acct_owner (or that account does not exist).");

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("GET bank-accounts", async () => {
    (fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await managerGet();
    const body = await res.json();
    expect(res.status).toBe(500);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("acct_owner");
    expect(serialized).not.toContain("does not have access");
    consoleErrorSpy.mockRestore();
  });
});
