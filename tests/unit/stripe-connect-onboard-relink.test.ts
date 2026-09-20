/**
 * Security-review follow-up (PLAN-0920-0853 payouts review, item 3): the
 * onboard routes used to clear `profiles.stripe_connect_account_id` on ANY
 * Stripe "does not have access to account" error — including a transient
 * platform-key hiccup on a routine page load — silently stranding the
 * manager's or vendor's saved id with no chance to recover it.
 *
 * Now a stale id is reported as `needsRelink` and left untouched; only an
 * explicit `{ relink: true }` body (the user's own "Reconnect" action) clears
 * it, and the id being replaced is logged first.
 *
 * This drives the REAL `ensureManagerConnectAccountId` / `clearManagerConnectAccountId`
 * / `resolveManagerConnectAccountId` implementations (not mocked) against a
 * fake Stripe client and an in-memory `profiles` row, so the route's own
 * orchestration is what's under test, not a stand-in for it.
 *
 * `vi.mock` is hoisted per module specifier, so every mock below is declared
 * ONCE at the top level (not inside a `describe`) and shared by both suites
 * through the mutable `profiles` / `payout` / `currentStripe` state that each
 * suite's own `beforeEach` resets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type ProfilesRow = { id: string; stripe_connect_account_id: string | null; email?: string; role?: string };

let profiles: ProfilesRow = { id: "owner-1", stripe_connect_account_id: null };

function sharedDb() {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: (_col: string, _val: string) => builder,
        maybeSingle: async () => (table === "profiles" ? { data: { ...profiles }, error: null } : { data: null, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, _val: string) => {
            if (table === "profiles" && "stripe_connect_account_id" in patch) {
              profiles.stripe_connect_account_id = patch.stripe_connect_account_id as string | null;
            }
            return { error: null };
          },
        }),
      };
      return builder;
    },
  };
}

const payout = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  isCoManagerForPayout: false,
  unresolvedReason: undefined as string | undefined,
};

vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payout,
  stripePayoutContextError: () => "unresolved",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "caller-1", email: "caller@example.com" } } }) },
    ...sharedDb(),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => sharedDb(),
}));

function accessErrorFor(accountId: string): Error {
  return new Error(`This API key does not have access to account ${accountId} (or that account does not exist).`);
}

let currentStripe: {
  accounts: {
    retrieve: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};
function makeStripe(opts: { staleAccountId: string; freshAccountId: string }) {
  return {
    accounts: {
      retrieve: vi.fn(async (id: string) => {
        if (id === opts.staleAccountId) throw accessErrorFor(id);
        return { id, details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" as const } };
      }),
      create: vi.fn(async () => ({ id: opts.freshAccountId })),
      update: vi.fn(async (id: string) => ({ id, capabilities: { transfers: "active" as const } })),
    },
  };
}
vi.mock("@/lib/stripe", () => ({ getStripe: () => currentStripe }));

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/stripe/connect/onboard — relink contract", () => {
  beforeEach(() => {
    payout.payoutOwnerUserId = "owner-1";
    profiles = { id: "owner-1", stripe_connect_account_id: "acct_stale", email: "owner@example.com" };
    currentStripe = makeStripe({ staleAccountId: "acct_stale", freshAccountId: "acct_fresh" });
  });

  it("without relink: keeps the saved id and reports needsRelink instead of wiping it", async () => {
    const { POST } = await import("@/app/api/stripe/connect/onboard/route");
    const res = await POST(new Request("http://x/api/stripe/connect/onboard", { method: "POST", body: JSON.stringify({}) }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "CONNECT_ACCOUNT_NEEDS_RELINK", needsRelink: true });
    expect(profiles.stripe_connect_account_id).toBe("acct_stale");
    expect(currentStripe.accounts.create).not.toHaveBeenCalled();
  });

  it("with relink: logs the old id, clears it, and creates a fresh account", async () => {
    const { POST } = await import("@/app/api/stripe/connect/onboard/route");
    const res = await POST(
      new Request("http://x/api/stripe/connect/onboard", { method: "POST", body: JSON.stringify({ relink: true }) }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mode: "embedded", accountId: "acct_fresh" });
    expect(profiles.stripe_connect_account_id).toBe("acct_fresh");
    expect(currentStripe.accounts.create).toHaveBeenCalledTimes(1);
    // The old id is logged BEFORE it's replaced.
    expect(consoleErrorSpy.mock.calls.some((call) => String(call[0]).includes("acct_stale"))).toBe(true);
  });

  it("with relink on a HEALTHY (still retrievable) account: refuses, never clears or replaces the id", async () => {
    // The saved account is genuinely reachable this time — Stripe's own
    // retrieve succeeds instead of throwing the access error.
    profiles = { id: "owner-1", stripe_connect_account_id: "acct_healthy", email: "owner@example.com" };
    currentStripe.accounts.retrieve = vi.fn(async (id: string) => ({
      id,
      details_submitted: true,
      payouts_enabled: true,
      capabilities: { transfers: "active" as const },
    }));

    const { POST } = await import("@/app/api/stripe/connect/onboard/route");
    const res = await POST(
      new Request("http://x/api/stripe/connect/onboard", { method: "POST", body: JSON.stringify({ relink: true }) }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "CONNECT_ACCOUNT_HEALTHY" });
    expect(profiles.stripe_connect_account_id).toBe("acct_healthy");
    expect(currentStripe.accounts.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/vendor/stripe-connect/onboard — relink contract", () => {
  beforeEach(() => {
    profiles = { id: "vendor-1", role: "vendor", stripe_connect_account_id: "acct_stale_v" };
    currentStripe = makeStripe({ staleAccountId: "acct_stale_v", freshAccountId: "acct_fresh_v" });
  });

  it("without relink: keeps the saved id and reports needsRelink instead of wiping it", async () => {
    const { POST } = await import("@/app/api/vendor/stripe-connect/onboard/route");
    const res = await POST(
      new Request("http://x/api/vendor/stripe-connect/onboard", { method: "POST", body: JSON.stringify({}) }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "CONNECT_ACCOUNT_NEEDS_RELINK", needsRelink: true });
    expect(profiles.stripe_connect_account_id).toBe("acct_stale_v");
    expect(currentStripe.accounts.create).not.toHaveBeenCalled();
  });

  it("with relink: logs the old id, clears it, and creates a fresh account", async () => {
    const { POST } = await import("@/app/api/vendor/stripe-connect/onboard/route");
    const res = await POST(
      new Request("http://x/api/vendor/stripe-connect/onboard", {
        method: "POST",
        body: JSON.stringify({ relink: true }),
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mode: "embedded", accountId: "acct_fresh_v" });
    expect(profiles.stripe_connect_account_id).toBe("acct_fresh_v");
    expect(currentStripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls.some((call) => String(call[0]).includes("acct_stale_v"))).toBe(true);
  });

  it("with relink on a HEALTHY (still retrievable) account: refuses, never clears or replaces the id", async () => {
    profiles = { id: "vendor-1", role: "vendor", stripe_connect_account_id: "acct_healthy_v" };
    currentStripe.accounts.retrieve = vi.fn(async (id: string) => ({
      id,
      details_submitted: true,
      payouts_enabled: true,
      capabilities: { transfers: "active" as const },
    }));

    const { POST } = await import("@/app/api/vendor/stripe-connect/onboard/route");
    const res = await POST(
      new Request("http://x/api/vendor/stripe-connect/onboard", {
        method: "POST",
        body: JSON.stringify({ relink: true }),
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "CONNECT_ACCOUNT_HEALTHY" });
    expect(profiles.stripe_connect_account_id).toBe("acct_healthy_v");
    expect(currentStripe.accounts.create).not.toHaveBeenCalled();
  });
});
