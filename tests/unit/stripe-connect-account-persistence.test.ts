/**
 * Regression: the Stripe Connect account id must be persisted with the
 * SERVICE-ROLE client, and a failed write must be surfaced.
 *
 * `20260722123000_lock_role_grant_surface.sql` revoked INSERT/UPDATE/DELETE on
 * `profiles` from `anon` and `authenticated`. Every caller of
 * `ensureManagerConnectAccountId` hands in the user-scoped server client, which
 * IS `authenticated` — so the write that stored the freshly created Connect
 * account id was denied, and because the result was never inspected the failure
 * was invisible.
 *
 * The user-visible consequence was the whole application funnel: a manager could
 * complete Stripe onboarding and PropLane would still answer "This property
 * manager has not connected Stripe payouts yet", so no applicant could ever pay
 * the application fee.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceUpdate = vi.fn();
const serviceEq = vi.fn();
const createServiceClient = vi.fn();

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => createServiceClient(),
}));

type Row = { stripe_connect_account_id: string | null };

/** A user-scoped client stand-in whose writes would be DENIED in production. */
function userScopedClient(profile: Row | null) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: { message: "permission denied for table profiles" } })) }));
  return {
    update,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: async () => ({ data: profile }) })),
      })),
      update,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceEq.mockResolvedValue({ error: null });
  serviceUpdate.mockReturnValue({ eq: serviceEq });
  createServiceClient.mockReturnValue({ from: vi.fn(() => ({ update: serviceUpdate })) });
});

describe("ensureManagerConnectAccountId", () => {
  it("persists a newly created account id through the service-role client", async () => {
    const { ensureManagerConnectAccountId } = await import("@/lib/stripe-connect-account");
    const db = userScopedClient({ stripe_connect_account_id: null });
    const stripe = {
      accounts: { create: vi.fn(async () => ({ id: "acct_new_123" })) },
    } as unknown as Parameters<typeof ensureManagerConnectAccountId>[0];

    const id = await ensureManagerConnectAccountId(stripe, db as never, {
      userId: "user-1",
      email: "mgr@example.com",
    });

    expect(id).toBe("acct_new_123");
    // The write went to the service-role client...
    expect(createServiceClient).toHaveBeenCalled();
    expect(serviceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_connect_account_id: "acct_new_123" }),
    );
    expect(serviceEq).toHaveBeenCalledWith("id", "user-1");
    // ...and NOT through the user-scoped client, whose UPDATE is revoked.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws rather than silently losing the id when the write fails", async () => {
    serviceEq.mockResolvedValue({ error: { message: "permission denied for table profiles" } });
    const { ensureManagerConnectAccountId } = await import("@/lib/stripe-connect-account");
    const db = userScopedClient({ stripe_connect_account_id: null });
    const stripe = {
      accounts: { create: vi.fn(async () => ({ id: "acct_new_456" })) },
    } as unknown as Parameters<typeof ensureManagerConnectAccountId>[0];

    await expect(
      ensureManagerConnectAccountId(stripe, db as never, { userId: "user-2" }),
    ).rejects.toThrow(/Failed to persist Stripe Connect account id/);
  });

  it("reuses an already-stored account id without writing again", async () => {
    const { ensureManagerConnectAccountId } = await import("@/lib/stripe-connect-account");
    const db = userScopedClient({ stripe_connect_account_id: "acct_existing" });
    const stripe = {
      accounts: {
        retrieve: vi.fn(async () => ({ id: "acct_existing" })),
        create: vi.fn(),
      },
    } as unknown as Parameters<typeof ensureManagerConnectAccountId>[0];

    const id = await ensureManagerConnectAccountId(stripe, db as never, { userId: "user-3" });
    expect(id).toBe("acct_existing");
    expect(serviceUpdate).not.toHaveBeenCalled();
  });
});

describe("clearManagerConnectAccountId", () => {
  it("clears through the service-role client, not the caller's client", async () => {
    const { clearManagerConnectAccountId } = await import("@/lib/stripe-connect");
    const db = userScopedClient({ stripe_connect_account_id: "acct_stale" });

    await clearManagerConnectAccountId(db as never, "user-4");

    expect(serviceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_connect_account_id: null }),
    );
    expect(serviceEq).toHaveBeenCalledWith("id", "user-4");
    expect(db.update).not.toHaveBeenCalled();
  });
});
