import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tier: vi.fn(),
  entitled: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: mocks.tier }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({
  numberServiceEntitled: mocks.entitled,
  NumberBillingError: class extends Error {},
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/workspaces/active.server", () => ({ ensureDefaultWorkspaceId: vi.fn(async () => "ws-1") }));

import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import { finishCommsCredit, reserveCommsCredit, settleCommsCreditQuantity } from "@/lib/comms-billing/wallet.server";

const OWNER = "owner-1";
const WS = "ws-1";

type Event = { key: string; total: number; inc: number; state: string };

/** A faithful-enough fake of the number-credit ledger plus the wallet RPCs (which just record calls). */
function makeDb(opts: { included?: number; walletKeys?: string[]; readError?: boolean } = {}) {
  const state = { included: opts.included ?? 300, events: [] as Event[], walletCalls: [] as string[], numberCalls: [] as string[] };
  const walletKeys = new Set(opts.walletKeys ?? []);
  const db = {
    state,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          filters[col] = v;
          return chain;
        },
        maybeSingle: async () => {
          if (opts.readError) return { data: null, error: { message: "boom" } };
          if (table === "number_credit_usage_events") {
            const e = state.events.find((x) => x.key === filters.idempotency_key);
            return { data: e ? { idempotency_key: e.key } : null, error: null };
          }
          if (table === "manager_comms_usage_events") {
            return { data: walletKeys.has(String(filters.idempotency_key)) ? { idempotency_key: filters.idempotency_key } : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
    async rpc(name: string, a: Record<string, unknown>) {
      if (name.startsWith("reserve_comms_credit") || name.startsWith("finish_comms_credit") || name.startsWith("settle_comms_credit")) {
        state.walletCalls.push(name);
        return name.startsWith("reserve") ? { data: { allowed: false, reason: "allowance_exhausted" }, error: null } : { data: true, error: null };
      }
      state.numberCalls.push(name);
      if (name === "reserve_number_credit") {
        const key = String(a.p_key);
        const existing = state.events.find((e) => e.key === key);
        if (existing) return { data: { allowed: true, duplicate: true, state: existing.state }, error: null };
        const cost = Math.round(Number(a.p_quantity) * Number(a.p_unit_cents));
        if (cost > state.included && a.p_allow_unfunded !== true) return { data: { allowed: false, reason: "allowance_exhausted" }, error: null };
        const inc = Math.min(cost, state.included);
        state.included -= inc;
        state.events.push({ key, total: cost, inc, state: "reserved" });
        return { data: { allowed: true, duplicate: false, state: "reserved" }, error: null };
      }
      if (name === "finish_number_credit") {
        const e = state.events.find((x) => x.key === a.p_key);
        if (!e) return { data: false, error: null };
        if (a.p_release) state.included += e.inc;
        e.state = a.p_release ? "released" : "settled";
        return { data: true, error: null };
      }
      if (name === "settle_number_credit_quantity") {
        const e = state.events.find((x) => x.key === a.p_key);
        if (!e) return { data: false, error: null };
        state.included += e.inc;
        e.inc = 0;
        e.state = "settled";
        return { data: true, error: null };
      }
      if (name === "number_credit_snapshot") {
        return {
          data: {
            included_remaining_cents: state.included,
            purchased_cents: 0,
            next_reset: "2026-11-01T00:00:00Z",
            subscription_status: "active",
          },
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
  return db;
}

const asDb = (d: ReturnType<typeof makeDb>) => d as never;
const reserve = (db: ReturnType<typeof makeDb>, key: string, quantity = 1, meter: "sms_outbound_segment" | "ai_agent_turn" = "sms_outbound_segment") =>
  reserveCommsCredit(asDb(db), { managerUserId: OWNER, workspaceId: WS, meter, quantity, idempotencyKey: key });

beforeEach(() => {
  mocks.tier.mockReset();
  mocks.entitled.mockReset();
  vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "0");
  mocks.tier.mockResolvedValue({ ok: true, tier: "free", liveSignupTrial: false });
  mocks.entitled.mockResolvedValue(true);
});

describe("Free manager with the PropLane Number add-on", () => {
  it("reserves against the number credit, never the workspace wallet", async () => {
    const db = makeDb();
    const r = await reserve(db, "sms_outbound:1", 2);
    expect(r).toMatchObject({ allowed: true, duplicate: false, state: "reserved" });
    expect(db.state.numberCalls).toEqual(["reserve_number_credit"]);
    expect(db.state.walletCalls).toEqual([]);
    expect(db.state.included).toBe(300 - 6);
  });

  it("consumes the included $3 and then refuses at the rate card (no overdraft)", async () => {
    const db = makeDb();
    for (let i = 0; i < 100; i++) expect((await reserve(db, `k${i}`, 1)).allowed).toBe(true);
    expect(db.state.included).toBe(0);
    const over = await reserve(db, "k100", 1);
    expect(over).toEqual({ allowed: false, reason: "allowance_exhausted" });
    // An AI turn (15c) is priced from the same rate card.
    const ai = makeDb({ included: 15 });
    expect((await reserve(ai, "ai:1", 1, "ai_agent_turn")).allowed).toBe(true);
    expect(ai.state.included).toBe(0);
  });

  it("hands the reservation back to the number credit when nothing went out", async () => {
    const db = makeDb();
    await reserve(db, "sms_outbound:2", 3);
    await finishCommsCredit(asDb(db), OWNER, "sms_outbound:2", true);
    expect(db.state.included).toBe(300);
    expect(db.state.events[0].state).toBe("released");
    expect(db.state.walletCalls).toEqual([]);
  });

  it("keeps the debit when the send happened, and settles a variable quantity on the same ledger", async () => {
    const db = makeDb();
    await reserve(db, "sms_outbound:3", 4);
    await finishCommsCredit(asDb(db), OWNER, "sms_outbound:3");
    expect(db.state.events[0].state).toBe("settled");
    await reserve(db, "voice:1", 5);
    await settleCommsCreditQuantity(asDb(db), OWNER, "voice:1", 1);
    expect(db.state.walletCalls).toEqual([]);
    expect(db.state.numberCalls).toContain("settle_number_credit_quantity");
  });

  it("a replayed key stays idempotent on the number ledger", async () => {
    const db = makeDb();
    await reserve(db, "sms_outbound:4", 1);
    const again = await reserve(db, "sms_outbound:4", 1);
    expect(again).toMatchObject({ allowed: true, duplicate: true });
    expect(db.state.included).toBe(297);
  });

  it("a key already reserved on the wallet keeps the wallet even once the add-on exists", async () => {
    const db = makeDb({ walletKeys: ["sms_outbound:old"] });
    await reserve(db, "sms_outbound:old", 1);
    expect(db.state.numberCalls).toEqual([]);
    expect(db.state.walletCalls).toEqual(["reserve_comms_credit"]);
  });

  it("settle and refund follow the number ledger even after the add-on lapses", async () => {
    const db = makeDb();
    await reserve(db, "sms_outbound:5", 2);
    mocks.entitled.mockResolvedValue(false);
    await finishCommsCredit(asDb(db), OWNER, "sms_outbound:5", true);
    expect(db.state.included).toBe(300);
    expect(db.state.walletCalls).toEqual([]);
  });

  it("send readiness gate passes on number credit and refuses when it cannot cover the send", async () => {
    expect(await evaluateManagerCommsBillingGate(asDb(makeDb()), OWNER, 3, WS)).toEqual({ allowed: true, billingOwnerId: OWNER });
    expect(await evaluateManagerCommsBillingGate(asDb(makeDb({ included: 2 })), OWNER, 3, WS)).toEqual({
      allowed: false,
      reason: "allowance_exhausted",
    });
  });

  it("an unreadable number balance fails closed (never a free send)", async () => {
    const db = makeDb();
    db.rpc = (async () => ({ data: null, error: { message: "down" } })) as never;
    expect(await evaluateManagerCommsBillingGate(asDb(db), OWNER, 3, WS)).toEqual({ allowed: false, reason: "plan_unreadable" });
  });

  it("an unreadable ledger lookup refuses a reserve, and still releases a reservation already debited", async () => {
    const db = makeDb({ readError: true });
    await expect(reserve(db, "sms_outbound:6", 1)).rejects.toThrow();
    // A finish must never abandon a debited reservation: it tries the number ledger, whose RPC refuses a key it does
    // not hold, and then the wallet. No ledger is guessed - each one answers for itself.
    await finishCommsCredit(asDb(db), OWNER, "sms_outbound:6", true);
    expect(db.state.numberCalls).toContain("finish_number_credit");
    expect(db.state.walletCalls).toContain("finish_comms_credit");
  });
});

describe("everyone else is unchanged", () => {
  it("a Free manager without the add-on reserves on the wallet", async () => {
    mocks.entitled.mockResolvedValue(false);
    const db = makeDb();
    const r = await reserve(db, "sms_outbound:7", 1);
    expect(r).toEqual({ allowed: false, reason: "allowance_exhausted" });
    expect(db.state.walletCalls).toEqual(["reserve_comms_credit"]);
    expect(db.state.numberCalls).toEqual([]);
  });

  it("a lapsed add-on (not active|past_due) reads as no add-on", async () => {
    mocks.entitled.mockResolvedValue(false);
    const db = makeDb();
    await reserve(db, "sms_outbound:8", 1);
    expect(db.state.numberCalls).toEqual([]);
  });

  it("a lapsed add-on still replays a key that was reserved on the number ledger", async () => {
    const db = makeDb();
    await reserve(db, "sms_outbound:11", 1);
    mocks.entitled.mockResolvedValue(false);
    const again = await reserve(db, "sms_outbound:11", 1);
    expect(again).toMatchObject({ allowed: true, duplicate: true });
    expect(db.state.walletCalls).toEqual([]);
    expect(db.state.included).toBe(297);
  });

  it("Pro and Business keep their plan credit and never touch the subscription", async () => {
    for (const tier of ["pro", "business"]) {
      mocks.tier.mockResolvedValue({ ok: true, tier, liveSignupTrial: false });
      const db = makeDb();
      await reserve(db, `sms_outbound:${tier}`, 1);
      expect(db.state.numberCalls).toEqual([]);
      expect(db.state.walletCalls).toEqual(["reserve_comms_credit"]);
      expect(mocks.entitled).not.toHaveBeenCalled();
    }
  });

  it("an unreadable plan falls to the existing wallet behaviour, not number credit", async () => {
    mocks.tier.mockResolvedValue({ ok: false });
    const db = makeDb();
    await expect(reserve(db, "sms_outbound:9", 1)).rejects.toThrow();
    expect(db.state.numberCalls).toEqual([]);
  });

  it("an unreadable subscription read falls to the wallet and never grants a send", async () => {
    mocks.entitled.mockRejectedValue(new Error("down"));
    const db = makeDb();
    const r = await reserve(db, "sms_outbound:10", 1);
    expect(r.allowed).toBe(false);
    expect(db.state.numberCalls).toEqual([]);
  });
});
