import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { creditPlatformHold } from "@/lib/stripe-platform-hold.server";

const input = { ownerUserId: "owner-1", ownerRole: "manager" as const,
  source: "application_fee" as const, sourceId: "cs_exact",
  amountCents: 5000, stripeChargeId: "ch_exact" };

function fakeDb(opts: { raced?: Record<string, unknown> | null; insertError?: { code?: string; message: string } | null }) {
  let reads = 0;
  return {
    from: vi.fn(() => ({
      select: () => {
        const chain = { eq: vi.fn(), maybeSingle: vi.fn() };
        chain.eq.mockReturnValue(chain);
        chain.maybeSingle.mockImplementation(async () => ({ data: ++reads === 1 ? null : opts.raced ?? null, error: null }));
        return chain;
      },
      insert: () => ({ select: () => ({ maybeSingle: async () => ({
        data: null, error: opts.insertError ?? null,
      }) }) }),
    })),
  };
}

describe("concurrent platform hold credit", () => {
  it("accepts an exact same-source duplicate and rejects a mismatched racing source", async () => {
    const raced = { id: "hold-1", owner_user_id: "owner-1", owner_role: "manager",
      source: "application_fee", source_id: "cs_exact", amount_cents: 5000,
      status: "held", stripe_charge_id: "ch_exact", stripe_transfer_id: null };
    const conflict = { code: "23505", message: "duplicate" };
    await expect(creditPlatformHold(fakeDb({ raced, insertError: conflict }) as never, input))
      .resolves.toMatchObject({ credited: false, hold: { id: "hold-1", amountCents: 5000 } });
    for (const altered of [
      { ...raced, owner_user_id: "other-owner" },
      { ...raced, amount_cents: 4000 },
      { ...raced, stripe_charge_id: "ch_other" },
    ]) {
      await expect(creditPlatformHold(fakeDb({ raced: altered, insertError: conflict }) as never, input))
        .rejects.toThrow(/Concurrent platform hold does not match/);
    }
    await expect(creditPlatformHold(fakeDb({ raced: null, insertError: conflict }) as never, input))
      .rejects.toThrow(/Concurrent platform hold does not match/);
  });

  it("does not report a successful credit when the insert returns no row", async () => {
    await expect(creditPlatformHold(fakeDb({}) as never, input))
      .rejects.toThrow(/no durable row/);
  });

  it("rereads conditional charge hydration and rejects a competing charge ID", async () => {
    const base = { id: "hold-1", owner_user_id: "owner-1", owner_role: "manager",
      source: "application_fee", source_id: "cs_exact", amount_cents: 5000,
      status: "held", stripe_transfer_id: null };
    let reads = 0;
    const db = { from: vi.fn(() => ({
      select: () => {
        const chain = { eq: vi.fn(), maybeSingle: vi.fn() };
        chain.eq.mockReturnValue(chain);
        chain.maybeSingle.mockImplementation(async () => ({ data: {
          ...base, stripe_charge_id: ++reads === 1 ? null : "ch_other",
        }, error: null }));
        return chain;
      },
      update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
    })) };
    await expect(creditPlatformHold(db as never, input))
      .rejects.toThrow(/hydration lost source arbitration/);
    expect(reads).toBe(2);
  });
});
