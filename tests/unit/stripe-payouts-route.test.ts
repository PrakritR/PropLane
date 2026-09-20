import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * These exercise the payout routes end to end against a fake Stripe client
 * and a fake Supabase table (only `@/lib/stripe-connect`'s account-id lookup
 * and the auth/ACL layers are mocked), so `createInAppPayout`'s real
 * claim-before-call + fresh-balance-re-read logic runs underneath every
 * route assertion — the same behavior a production request would hit.
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
    return {
      ok: false,
      status: 403 as const,
      error: "You do not have permission to change this account's bank details.",
    };
  },
}));

let sessionUser: { id: string } | null = { id: "caller-1" };
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));

type Row = Record<string, unknown>;

/** In-memory `stripe_payouts` table backing `createInAppPayout`'s claim pattern. */
function makeFakeDb() {
  const rows: Row[] = [];
  let nextId = 1;
  const client = {
    from(table: string) {
      if (table !== "stripe_payouts") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Row) => ({
          select: () => ({
            maybeSingle: async () => {
              const conflict = rows.some(
                (r) => r.stripe_connect_account_id === row.stripe_connect_account_id && r.status === "pending",
              );
              if (conflict) return { data: null, error: { message: "duplicate key" } };
              const id = `claim-${nextId++}`;
              rows.push({ id, ...row });
              return { data: { id }, error: null };
            },
          }),
        }),
        update: (patch: Row) => ({
          eq: (col: string, value: unknown) => {
            const row = rows.find((r) => r[col] === value);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
  return { client, rows };
}

let fakeDb = makeFakeDb();
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => fakeDb.client,
}));

type FakeStripeConfig = {
  availableCents: number;
  instantAvailableCents: number;
  bankInstantEligible: boolean;
  payoutCreate?: ReturnType<typeof vi.fn>;
};

function makeFakeStripe(config: FakeStripeConfig) {
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue({
        id: "acct_owner",
        details_submitted: true,
        requirements: { currently_due: [], pending_verification: [] },
        external_accounts: {
          data: [
            {
              object: "bank_account",
              last4: "4421",
              bank_name: "Chase",
              account_type: "checking",
              available_payout_methods: config.bankInstantEligible ? ["standard", "instant"] : ["standard"],
              default_for_currency: true,
            },
          ],
        },
      }),
      update: vi.fn().mockResolvedValue({
        settings: { payouts: { schedule: { interval: "manual" } } },
      }),
    },
    balance: {
      retrieve: vi.fn().mockResolvedValue({
        available: [{ amount: config.availableCents, currency: "usd" }],
        instant_available: [{ amount: config.instantAvailableCents, currency: "usd" }],
        pending: [{ amount: 0, currency: "usd" }],
      }),
    },
    payouts: {
      create: config.payoutCreate ?? vi.fn().mockResolvedValue({ id: "po_1", status: "pending", arrival_date: null }),
    },
  } as unknown as Stripe;
}

let fakeStripe = makeFakeStripe({ availableCents: 100_000, instantAvailableCents: 100_000, bankInstantEligible: true });
vi.mock("@/lib/stripe", () => ({ getStripe: () => fakeStripe }));

let connectAccountId: string | null = "acct_owner";
vi.mock("@/lib/stripe-connect", () => ({
  resolveManagerConnectAccountId: async () => connectAccountId,
}));

let vendorAccess: { ok: true; actor: { userId: string; email: string } } | { ok: false; status: 401 | 403 } = {
  ok: true,
  actor: { userId: "vendor-1", email: "vendor@example.com" },
};
vi.mock("@/lib/auth/vendor-api-access", () => ({
  requireVendorApiAccess: async () => vendorAccess,
}));

import { POST as managerCreate } from "@/app/api/stripe/payouts/create/route";
import { PUT as managerSchedule } from "@/app/api/stripe/payouts/schedule/route";
import { POST as vendorCreate } from "@/app/api/vendor/payouts/create/route";

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, { method, body: JSON.stringify(body) });
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
  fakeStripe = makeFakeStripe({ availableCents: 100_000, instantAvailableCents: 100_000, bankInstantEligible: true });
});

describe("POST /api/stripe/payouts/create — auth", () => {
  it("401s when there is no session", async () => {
    sessionUser = null;
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 100, method: "standard" }),
    );
    expect(res.status).toBe(401);
    expect(fakeDb.rows).toHaveLength(0);
  });

  it("422s a malformed body before any Stripe/DB work happens", async () => {
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: -5, method: "standard" }),
    );
    expect(res.status).toBe(422);
    expect(fakeDb.rows).toHaveLength(0);
  });
});

describe("POST /api/stripe/payouts/create — co-manager ACL", () => {
  it("403s a co-manager without the bank-edit permission — no Pay out", async () => {
    payoutContext.isCoManagerForPayout = true;
    payoutContext.canEditBankAccount = false;
    payoutContext.payoutOwnerUserId = "owner-2";

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(res.status).toBe(403);
    expect(fakeDb.rows).toHaveLength(0);
  });

  it("allows a co-manager who DOES hold the bank-edit permission", async () => {
    payoutContext.isCoManagerForPayout = true;
    payoutContext.canEditBankAccount = true;
    payoutContext.payoutOwnerUserId = "owner-2";

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(res.status).toBe(200);
    expect(fakeDb.rows[0]).toMatchObject({ manager_user_id: "owner-2", amount_cents: 5000 });
  });
});

describe("POST /api/stripe/payouts/create — 422 over balance, server re-reads the amount", () => {
  it("422s a standard amount over the freshly-read available balance, ignoring any stale client figure", async () => {
    fakeStripe = makeFakeStripe({ availableCents: 1000, instantAvailableCents: 0, bankInstantEligible: false });

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 500_000, method: "standard" }),
    );
    expect(res.status).toBe(422);
    expect((fakeStripe.payouts.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("re-derives eligibility from a fresh balance read rather than trusting the request", async () => {
    // The client could claim any instantAvailableCents it likes in theory — the
    // route never reads one from the body, so there is nothing to spoof; this
    // proves the server's own Stripe balance read is what decides the 422.
    fakeStripe = makeFakeStripe({ availableCents: 100_000, instantAvailableCents: 500, bankInstantEligible: true });

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 50_000, method: "instant" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/\$5\.00 now/);
  });

  it("computes fee/net server-side and sends Stripe the net amount for Instant", async () => {
    const payoutCreate = vi.fn().mockResolvedValue({ id: "po_2", status: "pending", arrival_date: null });
    fakeStripe = makeFakeStripe({
      availableCents: 100_000,
      instantAvailableCents: 100_000,
      bankInstantEligible: true,
      payoutCreate,
    });

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 100_000, method: "instant" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ payoutId: "po_2", amountCents: 100_000, feeCents: 1000, netCents: 99_000 });
    expect(payoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 99_000, method: "instant" }),
      expect.objectContaining({ stripeAccount: "acct_owner" }),
    );
  });

  it("422s when no Connect account exists yet, without ever calling Stripe", async () => {
    connectAccountId = null;
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(res.status).toBe(422);
    expect((fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("POST /api/stripe/payouts/create — 409 duplicate in-flight click", () => {
  it("409s a second concurrent click while the first payout is still pending", async () => {
    const first = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(first.status).toBe(200);
    expect(fakeDb.rows).toHaveLength(1);

    // Simulate the first payout still being "pending" (the webhook hasn't
    // resolved it yet) and click again.
    const second = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(second.status).toBe(409);
    expect(fakeDb.rows).toHaveLength(1); // no second row claimed
  });
});

describe("PUT /api/stripe/payouts/schedule — auth + ACL", () => {
  it("401s with no session", async () => {
    sessionUser = null;
    const res = await managerSchedule(jsonRequest("http://x/api/stripe/payouts/schedule", { interval: "manual" }, "PUT"));
    expect(res.status).toBe(401);
  });

  it("403s a read-only co-manager", async () => {
    payoutContext.isCoManagerForPayout = true;
    payoutContext.canEditBankAccount = false;
    payoutContext.payoutOwnerUserId = "owner-2";
    const res = await managerSchedule(jsonRequest("http://x/api/stripe/payouts/schedule", { interval: "manual" }, "PUT"));
    expect(res.status).toBe(403);
    expect((fakeStripe.accounts.update as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("422s an invalid schedule body", async () => {
    const res = await managerSchedule(jsonRequest("http://x/api/stripe/payouts/schedule", { interval: "yearly" }, "PUT"));
    expect(res.status).toBe(422);
  });

  it("writes and reads back the schedule for an authorized caller", async () => {
    const res = await managerSchedule(
      jsonRequest("http://x/api/stripe/payouts/schedule", { interval: "manual" }, "PUT"),
    );
    expect(res.status).toBe(200);
    expect((fakeStripe.accounts.update as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "acct_owner",
      expect.objectContaining({ settings: { payouts: { schedule: { interval: "manual" } } } }),
    );
  });
});

describe("POST /api/vendor/payouts/create — vendor scoping", () => {
  it("401s when the vendor session is missing", async () => {
    vendorAccess = { ok: false, status: 401 };
    const res = await vendorCreate(
      jsonRequest("http://x/api/vendor/payouts/create", { amountCents: 100, method: "standard" }),
    );
    expect(res.status).toBe(401);
  });

  it("403s a non-vendor caller", async () => {
    vendorAccess = { ok: false, status: 403 };
    const res = await vendorCreate(
      jsonRequest("http://x/api/vendor/payouts/create", { amountCents: 100, method: "standard" }),
    );
    expect(res.status).toBe(403);
  });

  it("scopes the payout to the vendor's own account id, ignoring a forged accountId in the body", async () => {
    const res = await vendorCreate(
      jsonRequest("http://x/api/vendor/payouts/create", {
        amountCents: 100,
        method: "standard",
        accountId: "acct_forged",
      }),
    );
    expect(res.status).toBe(200);
    expect(fakeDb.rows[0]).toMatchObject({
      manager_user_id: "vendor-1",
      vendor_user_id: "vendor-1",
      stripe_connect_account_id: "acct_owner",
    });
  });
});
