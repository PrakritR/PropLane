import { describe, expect, it, vi } from "vitest";

import { readOwnerPlatformFunds } from "@/lib/stripe-platform-hold.server";
import { emptyPayoutSnapshot, snapshotWithPlatformHolds } from "@/lib/stripe-payouts.server";

function dbFixture(opts: {
  held?: number; releasePending?: number;
  fundsError?: string; historyError?: string;
  historyRows?: Array<Record<string, unknown>>;
  serverCap?: number;
} = {}) {
  let historyOwner: string | null = null;
  let historyOrderCount = 0;
  const historyQuery = {
    eq: (_field: string, owner: string) => { historyOwner = owner; return historyQuery; },
    order: () => { historyOrderCount += 1; return historyQuery; },
    range: async (start: number, end: number) => ({
      data: (opts.historyRows ?? []).filter((row) => row.owner_user_id === historyOwner)
        .slice(start, Math.min(end + 1, start + (opts.serverCap ?? Number.MAX_SAFE_INTEGER))),
      error: opts.historyError ? { message: opts.historyError } : null,
    }),
  };
  const emptyQuery = {
    eq: () => emptyQuery,
    order: () => emptyQuery,
    range: async () => ({ data: [], error: null }),
  };
  return {
    rpc: vi.fn(async () => ({ data: [{ held_cents: opts.held ?? 50,
      release_pending_cents: opts.releasePending ?? 100 }],
      error: opts.fundsError ? { message: opts.fundsError } : null })),
    from: vi.fn((table: string) => ({ select: () => table === "platform_payment_holds"
      ? historyQuery : emptyQuery })),
    historyOrderCount: () => historyOrderCount,
  };
}

describe("platform money snapshot", () => {
  it("counts held and release-unknown separately from Stripe withdrawable funds", async () => {
    const db = dbFixture();
    const result = await snapshotWithPlatformHolds(db as never, "owner-1", {
      ...emptyPayoutSnapshot(), withdrawableCents: 200,
    });
    expect(result).toMatchObject({ heldCents: 50, releasePendingCents: 100,
      withdrawableCents: 200, availableCents: 250 });
    expect(db.rpc).toHaveBeenCalledWith("read_platform_hold_owner_funds", { p_owner: "owner-1" });
  });

  it("fails closed when held totals or history cannot be read", async () => {
    await expect(readOwnerPlatformFunds(dbFixture({ fundsError: "db unavailable" }) as never, "owner-1"))
      .rejects.toThrow(/could not read held payment funds/i);
    await expect(readOwnerPlatformFunds({ rpc: async () => ({ data: null, error: null }) } as never, "owner-1"))
      .rejects.toThrow(/invalid total/);
    for (const invalid of [null, "", " ", "01", -1, "9007199254740992"]) {
      await expect(readOwnerPlatformFunds({ rpc: async () => ({
        data: [{ held_cents: invalid, release_pending_cents: "0" }], error: null,
      }) } as never, "owner-1")).rejects.toThrow(/invalid total/);
    }
    await expect(readOwnerPlatformFunds({ rpc: async () => ({
      data: [{ held_cents: "100", release_pending_cents: "0" }], error: null,
    }) } as never, "owner-1")).resolves.toEqual({ heldCents: 100, releasePendingCents: 0 });
    await expect(snapshotWithPlatformHolds(dbFixture({ historyError: "history unavailable" }) as never, "owner-1"))
      .rejects.toThrow(/history unavailable/);
  });

  it("pages all owned hold history without treating a 500-row page as complete", async () => {
    const row = (id: number, owner = "owner-1") => ({ id: `hold-${id}`, owner_user_id: owner,
      owner_role: "manager", source: "application_fee", source_id: `source-${id}`,
      amount_cents: 1, status: "held", stripe_charge_id: `ch_${id}`,
      stripe_transfer_id: null, created_at: "2026-10-05T00:00:00Z" });
    const db = dbFixture({ historyRows: [...Array.from({ length: 501 }, (_, i) => row(i)), row(999, "other")] });
    const snapshot = await snapshotWithPlatformHolds(db as never, "owner-1");
    expect(snapshot.history).toHaveLength(501);
    expect(snapshot.history.some((entry) => entry.id === "hold:hold-999")).toBe(false);
    expect(db.historyOrderCount()).toBe(6);
    const capped = dbFixture({ historyRows: [...Array.from({ length: 501 }, (_, i) => row(i)), row(999, "other")],
      serverCap: 75 });
    expect((await snapshotWithPlatformHolds(capped as never, "owner-1")).history).toHaveLength(501);
    expect(capped.historyOrderCount()).toBe(16);
  });

  it("labels original captured allocation separately from mutable remaining source", async () => {
    const base = { owner_user_id: "owner-1", owner_role: "manager", source: "application_fee",
      status: "held", stripe_charge_id: "ch_1", stripe_transfer_id: null,
      created_at: "2026-10-05T00:00:00Z" };
    const db = dbFixture({ historyRows: [
      { ...base, id: "partial", source_id: "source-1", original_amount_cents: 100,
        amount_cents: 60 },
      { ...base, id: "spent", source_id: "source-2", original_amount_cents: 50,
        amount_cents: 0 },
      { ...base, id: "legacy", source_id: "source-3", original_amount_cents: null,
        amount_cents: 25 },
    ] });
    const history = (await snapshotWithPlatformHolds(db as never, "owner-1")).history;
    expect(history.map((row) => [row.id, row.amountCents, row.serviceLabel])).toEqual([
      ["hold:partial", 100, "Captured source allocation"],
      ["hold:spent", 50, "Captured source allocation"],
      ["hold:legacy", 25, "Remaining source amount"],
    ]);
  });
});
