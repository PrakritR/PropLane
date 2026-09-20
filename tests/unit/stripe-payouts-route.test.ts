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

/**
 * In-memory `stripe_payouts` table backing `createInAppPayout`'s claim
 * pattern and the reconciliation that now runs before every claim: the
 * partial pending-claim index, the `stripe_payout_id` unique index (an
 * update that would land a second row on the same id fails like Postgres
 * does), and the read/update/delete chains reconciliation uses.
 */
function makeFakeDb(seedRows: Row[] = []) {
  const rows: Row[] = [...seedRows];
  let nextId = 1;
  const failUpdatesOnce: { remaining: number } = { remaining: 0 };
  const failInsertOnce: { error: { code?: string; message: string } | null } = { error: null };
  const applyFilters = (filters: Array<(r: Row) => boolean>) => rows.filter((r) => filters.every((f) => f(r)));
  const client = {
    from(table: string) {
      if (table !== "stripe_payouts") throw new Error(`unexpected table ${table}`);
      const filters: Array<(r: Row) => boolean> = [];
      const chain = (mode: "select" | "update" | "delete", patch: Row = {}) => {
        const builder: Record<string, unknown> = {
          eq(col: string, value: unknown) {
            filters.push((r) => r[col] === value);
            return builder;
          },
          in(col: string, values: unknown[]) {
            filters.push((r) => values.includes(r[col]));
            return builder;
          },
          maybeSingle: async () => ({ data: applyFilters(filters)[0] ?? null, error: null }),
          then(resolve: (v: { data: Row[] | null; error: { code?: string; message: string } | null }) => unknown) {
            const matched = applyFilters(filters);
            if (mode === "update") {
              if (failUpdatesOnce.remaining > 0) {
                failUpdatesOnce.remaining -= 1;
                return resolve({ data: null, error: { message: "connection reset" } });
              }
              if (typeof patch.stripe_payout_id === "string") {
                const taken = rows.some(
                  (r) => r.stripe_payout_id === patch.stripe_payout_id && !matched.includes(r),
                );
                if (taken) {
                  return resolve({
                    data: null,
                    error: { code: "23505", message: 'duplicate key value violates unique constraint "stripe_payouts_stripe_id_unique"' },
                  });
                }
              }
              for (const r of matched) Object.assign(r, patch);
              return resolve({ data: matched, error: null });
            }
            if (mode === "delete") {
              for (const r of matched) rows.splice(rows.indexOf(r), 1);
              return resolve({ data: matched, error: null });
            }
            return resolve({ data: matched, error: null });
          },
        };
        return builder;
      };
      return {
        insert: (row: Row) => ({
          select: () => ({
            maybeSingle: async () => {
              if (failInsertOnce.error) {
                const error = failInsertOnce.error;
                failInsertOnce.error = null;
                return { data: null, error };
              }
              const conflict = rows.some(
                (r) => r.stripe_connect_account_id === row.stripe_connect_account_id && r.status === "pending" && r.initiated_in_app,
              );
              if (conflict) return { data: null, error: { message: "duplicate key" } };
              const id = `claim-${nextId++}`;
              rows.push({ id, created_at: new Date().toISOString(), ...row });
              return { data: { id }, error: null };
            },
          }),
        }),
        select: () => chain("select"),
        update: (patch: Row) => chain("update", patch),
        delete: () => chain("delete"),
      };
    },
  };
  return { client, rows, failUpdatesOnce, failInsertOnce };
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
  payoutRetrieve?: ReturnType<typeof vi.fn>;
  payoutList?: ReturnType<typeof vi.fn>;
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
              id: "ba_default",
              object: "bank_account",
              // Readiness (`stripe-payouts-readiness.server.ts`) requires a
              // VERIFIED destination, not merely "some external account" —
              // matches every test in this file expecting `setup.ready`.
              status: "verified",
              last4: "4421",
              bank_name: "Chase",
              account_type: "checking",
              available_payout_methods: config.bankInstantEligible ? ["standard", "instant"] : ["standard"],
              default_for_currency: true,
            },
            {
              id: "card_debit",
              object: "card",
              brand: "Visa",
              last4: "4242",
              funding: "debit",
              default_for_currency: false,
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
      retrieve: config.payoutRetrieve ?? vi.fn().mockResolvedValue({ id: "po_1", status: "pending", arrival_date: null }),
      list: config.payoutList ?? vi.fn().mockResolvedValue({ data: [] }),
    },
  } as unknown as Stripe;
}

let fakeStripe = makeFakeStripe({ availableCents: 100_000, instantAvailableCents: 100_000, bankInstantEligible: true });
vi.mock("@/lib/stripe", () => ({ getStripe: () => fakeStripe }));

let connectAccountId: string | null = "acct_owner";
vi.mock("@/lib/stripe-connect", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-connect")>("@/lib/stripe-connect");
  return {
    ...actual,
    resolveManagerConnectAccountId: async () => connectAccountId,
  };
});

let vendorAccess: { ok: true; actor: { userId: string; email: string } } | { ok: false; status: 401 | 403 } = {
  ok: true,
  actor: { userId: "vendor-1", email: "vendor@example.com" },
};
vi.mock("@/lib/auth/vendor-api-access", () => ({
  requireVendorApiAccess: async () => vendorAccess,
}));

import { POST as managerCreate } from "@/app/api/stripe/payouts/create/route";
import { PUT as managerSchedule } from "@/app/api/stripe/payouts/schedule/route";
import { GET as managerBalance } from "@/app/api/stripe/payouts/balance/route";
import { POST as vendorCreate } from "@/app/api/vendor/payouts/create/route";
import { GET as vendorBalance } from "@/app/api/vendor/payouts/balance/route";

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

  it("an insert failure that is NOT the unique-index conflict is a 500, never reported as a payout already in progress", async () => {
    fakeDb.failInsertOnce.error = { code: "42501", message: "permission denied for table stripe_payouts" };
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).not.toMatch(/already in progress/i);
    expect(fakeDb.rows).toHaveLength(0);
    expect((fakeStripe.payouts.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("reconciles a pending claim against Stripe before a new click — a payout Stripe has since paid no longer blocks", async () => {
    const first = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(first.status).toBe(200);

    // No webhook ever arrived, but Stripe itself now reports the payout paid.
    (fakeStripe.payouts.retrieve as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "po_1",
      status: "paid",
      arrival_date: 1_790_000_000,
    });
    (fakeStripe.payouts.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "po_2", status: "pending", arrival_date: null });

    const second = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(second.status).toBe(200);
    expect(fakeStripe.payouts.retrieve).toHaveBeenCalledWith("po_1", {}, { stripeAccount: "acct_owner" });
    expect(fakeDb.rows.map((r) => [r.stripe_payout_id, r.status])).toEqual([
      ["po_1", "paid"],
      ["po_2", "pending"],
    ]);
  });

  it("merges the claim onto a webhook-inserted row for the same payout id instead of leaving a stuck pending claim", async () => {
    // The `payout.created` webhook beat the stamp: its own row for po_1 is
    // already there (initiated_in_app false, net amount).
    fakeDb = makeFakeDb([
      {
        id: "hook-1",
        manager_user_id: "owner-1",
        stripe_connect_account_id: "acct_owner",
        stripe_payout_id: "po_1",
        amount_cents: 99_000,
        fee_cents: null,
        method: "instant",
        status: "pending",
        initiated_in_app: false,
        created_at: new Date().toISOString(),
      },
    ]);

    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 100_000, method: "instant" }),
    );
    expect(res.status).toBe(200);

    // Exactly one row survives: the webhook's, now carrying the claim's own
    // gross amount / fee and flagged as in-app. The claim row is gone, so the
    // pending-claim index holds nothing that can never be advanced.
    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0]).toMatchObject({
      id: "hook-1",
      stripe_payout_id: "po_1",
      initiated_in_app: true,
      amount_cents: 100_000,
      fee_cents: 1000,
      method: "instant",
    });
  });

  it("retries a transient stamp failure once, and the payout still succeeds", async () => {
    fakeDb.failUpdatesOnce.remaining = 1;
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(res.status).toBe(200);
    expect(fakeDb.rows[0]).toMatchObject({ stripe_payout_id: "po_1", status: "pending" });
  });

  it("recovers an unstamped claim by matching Stripe's own payout list, and writes off one Stripe never saw", async () => {
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fakeDb = makeFakeDb([
      {
        id: "orphan-matched",
        manager_user_id: "owner-1",
        stripe_connect_account_id: "acct_owner",
        stripe_payout_id: null,
        amount_cents: 5000,
        fee_cents: 0,
        method: "standard",
        status: "pending",
        initiated_in_app: true,
        created_at: twentyMinutesAgo,
      },
    ]);
    (fakeStripe.payouts.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ id: "po_lost", amount: 5000, method: "standard", status: "in_transit", arrival_date: null }],
    });
    const recovered = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(recovered.status).toBe(200);
    expect(fakeDb.rows.find((r) => r.id === "orphan-matched")).toMatchObject({ stripe_payout_id: "po_lost", status: "in_transit" });

    // A second orphan older than the grace window with NO matching Stripe
    // payout is written off as failed so it can never block Pay out.
    fakeDb = makeFakeDb([
      {
        id: "orphan-unconfirmed",
        manager_user_id: "owner-1",
        stripe_connect_account_id: "acct_owner",
        stripe_payout_id: null,
        amount_cents: 7000,
        fee_cents: 0,
        method: "standard",
        status: "pending",
        initiated_in_app: true,
        created_at: twentyMinutesAgo,
      },
    ]);
    (fakeStripe.payouts.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    const unblocked = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expect(unblocked.status).toBe(200);
    expect(fakeDb.rows.find((r) => r.id === "orphan-unconfirmed")).toMatchObject({ status: "failed" });
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

describe("Security review — a thrown Stripe error's own message never reaches the response body", () => {
  // Stripe's real "does not have access to account" text embeds the Connect
  // account id verbatim. Every route below used to return that message
  // straight through (`{ error: msg }` at 400, or `e.message` at 500); now
  // it must be logged server-side and answered with one generic message.
  const stripeAccountLeak = () =>
    new Error("This API key does not have access to account acct_owner (or that account does not exist).");

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  function expectNoLeakButLogged(status: number, body: Record<string, unknown>) {
    expect(status).toBe(500);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("acct_owner");
    expect(serialized).not.toContain("does not have access");
    expect(
      consoleErrorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes("acct_owner"))),
    ).toBe(true);
  }

  // Balance GET recognizes this exact "account no longer reachable" signature
  // and answers with `needsRelink` (see stripe-connect-onboard-relink.test.ts)
  // instead of the generic 500 — a different, equally leak-free path: the
  // raw Stripe message never reaches the body either way.
  function expectNoLeakViaRelink(status: number, body: Record<string, unknown>) {
    expect(status).toBe(200);
    expect(body).toMatchObject({ needsRelink: true });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("acct_owner");
    expect(serialized).not.toContain("does not have access");
  }

  it("manager balance GET", async () => {
    (fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await managerBalance();
    expectNoLeakViaRelink(res.status, await res.json());
  });

  it("vendor balance GET", async () => {
    (fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await vendorBalance();
    expectNoLeakViaRelink(res.status, await res.json());
  });

  it("manager create POST", async () => {
    (fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await managerCreate(
      jsonRequest("http://x/api/stripe/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expectNoLeakButLogged(res.status, await res.json());
  });

  it("vendor create POST", async () => {
    (fakeStripe.accounts.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await vendorCreate(
      jsonRequest("http://x/api/vendor/payouts/create", { amountCents: 5000, method: "standard" }),
    );
    expectNoLeakButLogged(res.status, await res.json());
  });

  it("manager schedule PUT", async () => {
    (fakeStripe.accounts.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(stripeAccountLeak());
    const res = await managerSchedule(jsonRequest("http://x/api/stripe/payouts/schedule", { interval: "manual" }, "PUT"));
    expectNoLeakButLogged(res.status, await res.json());
  });
});
