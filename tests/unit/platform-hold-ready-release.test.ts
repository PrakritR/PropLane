import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

vi.mock("@/lib/stripe-connect", () => ({ connectAccountReadyForAchPayouts: (a: { payouts_enabled?: boolean }) => a.payouts_enabled === true }));
vi.mock("@/lib/stripe-webhook-financials", () => ({ handleStripeAccountUpdated: vi.fn() }));

import { releaseReadyPlatformHolds } from "@/lib/platform-hold-ready-release.server";

const held = (owner: string, over: Record<string, unknown> = {}) => ({
  id: `h-${owner}`, owner_user_id: owner, status: "classified_held", source_verified_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", ...over,
});

function stripeWith(accounts: Record<string, Record<string, unknown>>) {
  return { accounts: { retrieve: vi.fn(async (id: string) => { if (!accounts[id]) throw new Error("no such account"); return accounts[id]; }) } } as never;
}

describe("release-ready-holds backstop", () => {
  const apply = vi.fn(async () => undefined);
  beforeEach(() => apply.mockClear());

  it("applies a payouts-enabled owner's account exactly like the account.updated webhook, once per owner", async () => {
    const f = fakeOwnerDb({
      platform_payment_holds: [held("u1"), held("u1", { id: "h-u1-b" }), held("u2")],
      profiles: [{ id: "u1", stripe_connect_account_id: "acct_1" }, { id: "u2", stripe_connect_account_id: "acct_2" }],
    });
    const stripe = stripeWith({
      acct_1: { id: "acct_1", payouts_enabled: true, metadata: { axis_user_id: "u1" } },
      acct_2: { id: "acct_2", payouts_enabled: false, metadata: { axis_user_id: "u2" } },
    });
    const result = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(result).toMatchObject({ owners: 2, ready: 1, notReady: 1, errors: [] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0] as unknown[])[1]).toMatchObject({ id: "acct_1" });
  });

  it("does nothing for an owner with no saved account, an unverified hold, or an account that is someone else's", async () => {
    const f = fakeOwnerDb({
      platform_payment_holds: [held("u1"), held("u2", { source_verified_at: null }), held("u3")],
      profiles: [{ id: "u1", stripe_connect_account_id: null }, { id: "u2", stripe_connect_account_id: "acct_2" }, { id: "u3", stripe_connect_account_id: "acct_3" }],
    });
    const stripe = stripeWith({
      acct_2: { id: "acct_2", payouts_enabled: true, metadata: { axis_user_id: "u2" } },
      acct_3: { id: "acct_3", payouts_enabled: true, metadata: { axis_user_id: "somebody-else" } },
    });
    const result = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(apply).not.toHaveBeenCalled();
    expect(result.ready).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it("a failing owner is reported and does not stop the next one; a re-run is the same call (idempotent)", async () => {
    const f = fakeOwnerDb({
      platform_payment_holds: [held("u1"), held("u2")],
      profiles: [{ id: "u1", stripe_connect_account_id: "acct_1" }, { id: "u2", stripe_connect_account_id: "acct_2" }],
    });
    const stripe = stripeWith({
      acct_1: { id: "acct_1", payouts_enabled: true, metadata: { axis_user_id: "u1" } },
      acct_2: { id: "acct_2", payouts_enabled: true, metadata: { axis_user_id: "u2" } },
    });
    apply.mockRejectedValueOnce(new Error("stripe blinked"));
    const first = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(first.errors).toEqual(["u1: stripe blinked"]);
    expect(first.ready).toBe(1);
    const second = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(second.errors).toEqual([]);
    expect(second.ready).toBe(2);
  });

  it("returns an empty result when nothing is held", async () => {
    const f = fakeOwnerDb({ platform_payment_holds: [] });
    expect(await releaseReadyPlatformHolds(f.db, stripeWith({}), { applyAccount: apply })).toMatchObject({ owners: 0, ready: 0 });
  });

  // Review fix, Oct 20: a flat window of the OLDEST rows starved every other owner. One owner whose holds never
  // release (a frozen unsigned service workspace, an account that will never be payouts-ready) sits permanently at
  // the head, so once they hold more rows than the window nobody behind them is ever read - and an owner whose
  // `account.updated` webhook was lost is never released. The read pages on `created_at` for DISTINCT owners.
  // Review fix, Oct 20: `created_at` alone is not a key. Advancing past the boundary with `gt` stepped over every
  // other row sharing that timestamp - and rows written by one batch or backfill all share one - so an owner whose
  // only holds sat on the boundary was skipped on every run. The page is a keyset on (created_at, id).
  it("reaches an owner whose only holds share the page boundary's timestamp", async () => {
    const BOUNDARY = "2026-03-01T00:00:00Z";
    // Exactly one page of the stuck owner, every row on one timestamp, and the waiting owner on that SAME stamp.
    const stuck = Array.from({ length: 1_000 }, (_, i) => held("stuck", { id: `h-stuck-${String(i).padStart(4, "0")}`, created_at: BOUNDARY }));
    const f = fakeOwnerDb({
      platform_payment_holds: [...stuck, held("waiting", { id: "h-zz-waiting", created_at: BOUNDARY })],
      profiles: [
        { id: "stuck", stripe_connect_account_id: "acct_stuck" },
        { id: "waiting", stripe_connect_account_id: "acct_waiting" },
      ],
    });
    const stripe = stripeWith({
      acct_stuck: { id: "acct_stuck", payouts_enabled: false, metadata: { axis_user_id: "stuck" } },
      acct_waiting: { id: "acct_waiting", payouts_enabled: true, metadata: { axis_user_id: "waiting" } },
    });
    const result = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(result).toMatchObject({ owners: 2, ready: 1, notReady: 1, errors: [] });
    expect((apply.mock.calls[0] as unknown[])[1]).toMatchObject({ id: "acct_waiting" });
  });

  it("stops instead of re-reading a page it cannot advance past", async () => {
    // Every row on one timestamp and more than one page of them: there is no cursor that moves, so the run must
    // finish with what it read rather than walking the same page to its page cap.
    const f = fakeOwnerDb({
      platform_payment_holds: Array.from({ length: 1_200 }, (_, i) =>
        held("stuck", { id: `h-${String(i).padStart(4, "0")}`, created_at: "2026-03-01T00:00:00Z" })),
      profiles: [{ id: "stuck", stripe_connect_account_id: "acct_stuck" }],
    });
    const stripe = stripeWith({ acct_stuck: { id: "acct_stuck", payouts_enabled: true, metadata: { axis_user_id: "stuck" } } });
    expect(await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply })).toMatchObject({ owners: 1, ready: 1, errors: [] });
  });

  it("reaches an owner behind thousands of a stuck owner's holds", async () => {
    const stuck = Array.from({ length: 2_400 }, (_, i) => held("stuck", {
      id: `h-stuck-${i}`,
      created_at: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    }));
    const f = fakeOwnerDb({
      platform_payment_holds: [...stuck, held("waiting", { id: "h-waiting", created_at: "2026-06-01T00:00:00Z" })],
      profiles: [
        { id: "stuck", stripe_connect_account_id: "acct_stuck" },
        { id: "waiting", stripe_connect_account_id: "acct_waiting" },
      ],
    });
    const stripe = stripeWith({
      acct_stuck: { id: "acct_stuck", payouts_enabled: false, metadata: { axis_user_id: "stuck" } },
      acct_waiting: { id: "acct_waiting", payouts_enabled: true, metadata: { axis_user_id: "waiting" } },
    });
    const result = await releaseReadyPlatformHolds(f.db, stripe, { applyAccount: apply });
    expect(result).toMatchObject({ owners: 2, ready: 1, notReady: 1, errors: [] });
    expect((apply.mock.calls[0] as unknown[])[1]).toMatchObject({ id: "acct_waiting" });
  });
});

describe("the cron route", () => {
  it("is CRON_SECRET-gated", async () => {
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.doMock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
    vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
    const { GET } = await import("@/app/api/cron/release-ready-holds/route");
    const res = await GET(new Request("http://localhost/api/cron/release-ready-holds"));
    expect(res.status).toBe(401);
    const ok = await GET(new Request("http://localhost/api/cron/release-ready-holds", { headers: { authorization: "Bearer wrong" } }));
    expect(ok.status).toBe(401);
    vi.unstubAllEnvs();
  });
});
