import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  tier: vi.fn(),
  loadWorkspaces: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: mocks.tier,
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: mocks.loadWorkspaces,
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn(async () => undefined),
  captureTestWorkspaceEffectForUser: vi.fn(async () => ({ captured: false })),
}));

import {
  loadOrderedPoolFunders,
  reserveCommsCreditPool,
  setFunderFundingScope,
  setFunderWorkspaceMonthlyLimit,
  finishCommsCreditPool,
  reverseCommsCreditPoolForPaymentIntent,
  fulfillCommsCreditPoolPurchase,
  loadCommsPlanCreditRules,
  isMissingPoolSchemaError,
} from "@/lib/comms-billing/pool.server";
import { reserveCommsCredit, finishCommsCredit } from "@/lib/comms-billing/wallet.server";
import { isCommsCreditPoolEnabled } from "@/lib/comms-billing/rates";

const OWNER = "owner-uuid";
const MEMBER = "member-uuid";
const WORKSPACE = "workspace-uuid";

describe("isCommsCreditPoolEnabled", () => {
  it("defaults ON when unset (captain, 2026-09-28)", () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", undefined);
    expect(isCommsCreditPoolEnabled()).toBe(true);
  });

  it("is off for '0', 'false', or 'off' (case/whitespace-insensitive)", () => {
    for (const value of ["0", "false", "off", "FALSE", "OFF", " 0 "]) {
      vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", value);
      expect(isCommsCreditPoolEnabled()).toBe(false);
    }
  });

  it("is on for '1', 'true', or any other value", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", value);
      expect(isCommsCreditPoolEnabled()).toBe(true);
    }
  });
});

function fundingDb(rows: { funder_user_id: string; created_at: string }[], ownerId = OWNER) {
  return {
    from: (table: string) => {
      if (table === "portal_workspaces") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: WORKSPACE, owner_user_id: ownerId }, error: null }) }) }) };
      }
      if (table === "comms_workspace_funding") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: async () => ({ data: rows, error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("loadOrderedPoolFunders", () => {
  it("puts the workspace owner first regardless of funding-grant order", async () => {
    mocks.tier.mockImplementation(async (id: string) => ({ ok: true, tier: id === OWNER ? "business" : "pro" }));
    const db = fundingDb([
      { funder_user_id: MEMBER, created_at: "2026-01-01" },
      { funder_user_id: OWNER, created_at: "2026-02-01" },
    ]);
    const funders = await loadOrderedPoolFunders(db as never, WORKSPACE);
    expect(funders.map((f) => f.funderUserId)).toEqual([OWNER, MEMBER]);
    expect(funders.find((f) => f.funderUserId === OWNER)?.tier).toBe("business");
  });

  it("drops a funder whose plan tier cannot be verified rather than guessing", async () => {
    mocks.tier.mockImplementation(async (id: string) => (id === OWNER ? { ok: false } : { ok: true, tier: "pro" }));
    const db = fundingDb([
      { funder_user_id: OWNER, created_at: "2026-01-01" },
      { funder_user_id: MEMBER, created_at: "2026-01-02" },
    ]);
    const funders = await loadOrderedPoolFunders(db as never, WORKSPACE);
    expect(funders.map((f) => f.funderUserId)).toEqual([MEMBER]);
  });

  it("returns nothing when the funding table cannot be read", async () => {
    const db = {
      from: (table: string) => {
        if (table === "portal_workspaces") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "down" } }) }) }) }) };
      },
    };
    expect(await loadOrderedPoolFunders(db as never, WORKSPACE)).toEqual([]);
  });
});

describe("reserveCommsCreditPool", () => {
  it("passes the ordered funder list and reports which funder paid", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro" });
    const rpc = vi.fn(async () => ({ data: { allowed: true, duplicate: false, state: "reserved", funder: OWNER }, error: null }));
    const db = { ...fundingDb([{ funder_user_id: OWNER, created_at: "2026-01-01" }]), rpc };
    const result = await reserveCommsCreditPool(db as never, {
      managerUserId: OWNER,
      workspaceId: WORKSPACE,
      meter: "sms_outbound_segment",
      idempotencyKey: "key-1",
    });
    expect(result).toEqual({ allowed: true, duplicate: false, state: "reserved", funderUserId: OWNER });
    expect(rpc).toHaveBeenCalledWith(
      "reserve_comms_credit_pool",
      expect.objectContaining({
        p_manager_context: OWNER,
        p_workspace: WORKSPACE,
        p_funders: [{ funder: OWNER, tier: "pro" }],
        p_key: "key-1",
      }),
    );
  });

  it("surfaces an allowance_exhausted refusal from the database untouched", async () => {
    mocks.tier.mockResolvedValue({ ok: true, tier: "free" });
    const rpc = vi.fn(async () => ({ data: { allowed: false, reason: "allowance_exhausted" }, error: null }));
    const db = { ...fundingDb([]), rpc };
    const result = await reserveCommsCreditPool(db as never, {
      managerUserId: OWNER,
      workspaceId: WORKSPACE,
      meter: "sms_outbound_segment",
      idempotencyKey: "key-2",
    });
    expect(result).toEqual({ allowed: false, reason: "allowance_exhausted" });
  });

  it("rejects an empty workspace id before ever touching the database", async () => {
    await expect(
      reserveCommsCreditPool({} as never, {
        managerUserId: OWNER,
        workspaceId: "  ",
        meter: "sms_outbound_segment",
        idempotencyKey: "key-3",
      }),
    ).rejects.toThrow("Invalid communication usage.");
  });
});

describe("finishCommsCreditPool", () => {
  it("reads the funder and workspace off the event, never a caller-supplied identity", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await finishCommsCreditPool({ rpc } as never, OWNER, "key-4", true);
    expect(rpc).toHaveBeenCalledWith("finish_comms_credit_pool", { p_manager_context: OWNER, p_key: "key-4", p_release: true });
  });

  it("throws when the database refuses the reconciliation", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    await expect(finishCommsCreditPool({ rpc } as never, OWNER, "key-5")).rejects.toThrow("reconciliation failed");
  });
});

describe("funder funding scope", () => {
  it("pinning one workspace enables only that workspace and disables every other accessible one", async () => {
    mocks.loadWorkspaces.mockResolvedValue([{ id: "ws-a" }, { id: "ws-b" }, { id: "ws-c" }]);
    const upsert = vi.fn(async () => ({ error: null }));
    const db = { from: () => ({ upsert }) };
    await setFunderFundingScope(db as never, OWNER, { kind: "one", workspaceId: "ws-b" });
    const rows = upsert.mock.calls[0]![0] as { workspace_id: string; enabled: boolean }[];
    expect(rows.find((r) => r.workspace_id === "ws-a")?.enabled).toBe(false);
    expect(rows.find((r) => r.workspace_id === "ws-b")?.enabled).toBe(true);
    expect(rows.find((r) => r.workspace_id === "ws-c")?.enabled).toBe(false);
  });

  it("all my workspaces enables every accessible workspace", async () => {
    mocks.loadWorkspaces.mockResolvedValue([{ id: "ws-a" }, { id: "ws-b" }]);
    const upsert = vi.fn(async () => ({ error: null }));
    const db = { from: () => ({ upsert }) };
    await setFunderFundingScope(db as never, OWNER, { kind: "all" });
    const rows = upsert.mock.calls[0]![0] as { enabled: boolean }[];
    expect(rows.every((r) => r.enabled)).toBe(true);
  });

  it("refuses to pin a workspace the funder cannot access — never trusts the client's id", async () => {
    mocks.loadWorkspaces.mockResolvedValue([{ id: "ws-a" }]);
    await expect(setFunderFundingScope({} as never, OWNER, { kind: "one", workspaceId: "not-mine" })).rejects.toThrow(
      "workspace you have access to",
    );
  });
});

describe("per-workspace monthly limit", () => {
  it("only narrows an already-funded (enabled) workspace, re-derived server-side", async () => {
    mocks.loadWorkspaces.mockResolvedValue([{ id: WORKSPACE }]);
    const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null, count: 1 }) }) }) }));
    const db = { from: () => ({ update }) };
    await expect(setFunderWorkspaceMonthlyLimit(db as never, OWNER, WORKSPACE, 2500)).resolves.toBeUndefined();
  });

  it("refuses to set a limit on a workspace that is not currently funded", async () => {
    mocks.loadWorkspaces.mockResolvedValue([{ id: WORKSPACE }]);
    const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null, count: 0 }) }) }) }));
    const db = { from: () => ({ update }) };
    await expect(setFunderWorkspaceMonthlyLimit(db as never, OWNER, WORKSPACE, 2500)).rejects.toThrow("Turn on funding");
  });

  it("refuses a workspace the funder cannot access", async () => {
    mocks.loadWorkspaces.mockResolvedValue([]);
    await expect(setFunderWorkspaceMonthlyLimit({} as never, OWNER, WORKSPACE, 2500)).rejects.toThrow(
      "workspace you have access to",
    );
  });
});

describe("wallet.server dispatch on COMMS_CREDIT_POOL_ENABLED", () => {
  it("flag explicitly off ('0'): reserveCommsCredit calls the legacy per-workspace RPC unchanged", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "0");
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro" });
    const rpc = vi.fn(async (name: string) => {
      if (name === "ensure_default_portal_workspace") return { data: "default-ws", error: null };
      return { data: { allowed: true, duplicate: false, state: "reserved" }, error: null };
    });
    const db = { rpc };
    await reserveCommsCredit(db as never, {
      managerUserId: OWNER,
      meter: "sms_outbound_segment",
      idempotencyKey: "legacy-key",
    });
    expect(rpc).toHaveBeenCalledWith("reserve_comms_credit", expect.objectContaining({ p_key: "legacy-key" }));
  });

  it("flag unset (default ON, captain 2026-09-28): reserveCommsCredit refuses rather than defaulting when no workspace is named", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", undefined);
    const result = await reserveCommsCredit({} as never, {
      managerUserId: OWNER,
      meter: "sms_outbound_segment",
      idempotencyKey: "pool-key-unset",
    });
    expect(result).toEqual({ allowed: false, reason: "workspace_unknown" });
  });

  it("flag on: reserveCommsCredit refuses rather than defaulting when no workspace is named", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "1");
    const result = await reserveCommsCredit({} as never, {
      managerUserId: OWNER,
      meter: "sms_outbound_segment",
      idempotencyKey: "pool-key",
    });
    expect(result).toEqual({ allowed: false, reason: "workspace_unknown" });
  });

  it("flag on: finishCommsCredit reconciles through the pool function", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "1");
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await finishCommsCredit({ rpc } as never, OWNER, "pool-key-2", false);
    expect(rpc).toHaveBeenCalledWith("finish_comms_credit_pool", { p_manager_context: OWNER, p_key: "pool-key-2", p_release: false });
  });

  it("flag on but the pool schema is not deployed yet: reserveCommsCredit falls back to the legacy wallet instead of throwing", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "1");
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro" });
    const rpc = vi.fn(async (name: string) => {
      if (name === "reserve_comms_credit_pool") {
        return { data: null, error: { code: "42P01", message: 'relation "public.comms_account_pools" does not exist' } };
      }
      if (name === "ensure_default_portal_workspace") return { data: "default-ws", error: null };
      return { data: { allowed: true, duplicate: false, state: "reserved" }, error: null };
    });
    const db = { ...fundingDb([{ funder_user_id: OWNER, created_at: "2026-01-01" }]), rpc };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await reserveCommsCredit(db as never, {
      managerUserId: OWNER,
      workspaceId: WORKSPACE,
      meter: "sms_outbound_segment",
      idempotencyKey: "fallback-key",
    });
    expect(rpc).toHaveBeenCalledWith("reserve_comms_credit", expect.objectContaining({ p_key: "fallback-key" }));
    expect(result).toEqual({ allowed: true, duplicate: false, state: "reserved" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("flag on but the pool schema is not deployed yet: a genuine database error still throws (never silently swallowed)", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "1");
    mocks.tier.mockResolvedValue({ ok: true, tier: "pro" });
    const rpc = vi.fn(async () => ({ data: null, error: { code: "08006", message: "connection failure" } }));
    const db = { ...fundingDb([{ funder_user_id: OWNER, created_at: "2026-01-01" }]), rpc };
    await expect(
      reserveCommsCredit(db as never, {
        managerUserId: OWNER,
        workspaceId: WORKSPACE,
        meter: "sms_outbound_segment",
        idempotencyKey: "genuine-error-key",
      }),
    ).rejects.toThrow("Communication credit could not be reserved.");
  });
});

/**
 * Staging/production run this code with `COMMS_CREDIT_POOL_ENABLED` off AND
 * without the pool migration applied at all — its tables do not exist there.
 * The Stripe webhook calls `reverseCommsCreditPoolForPaymentIntent` (and,
 * before it, `fulfillCommsCreditPoolPurchase` for a matching purpose)
 * unconditionally on every refund/dispute/checkout event, alongside the
 * legacy reconciliation in the SAME request. Either must treat "the table
 * isn't there" as "not a pool purchase" and return normally — never throw,
 * which would mark the whole webhook request failed and disturb the legacy
 * handling running in parallel.
 */
describe("pool functions are inert where the schema is not deployed (flag off, no migration)", () => {
  const missingTable = { code: "42P01", message: 'relation "public.comms_pool_credit_purchases" does not exist' };
  const schemaCacheMiss = { code: "PGRST205", message: "Could not find the table 'public.comms_pool_credit_purchases' in the schema cache" };
  const genuineError = { code: "08006", message: "connection failure" };

  it.each([
    ["42P01 (undefined_table)", missingTable],
    ["PGRST205 (schema cache miss)", schemaCacheMiss],
  ])("isMissingPoolSchemaError recognizes %s", (_label, error) => {
    expect(isMissingPoolSchemaError(error)).toBe(true);
  });

  it("isMissingPoolSchemaError does not swallow a genuine database error", () => {
    expect(isMissingPoolSchemaError(genuineError)).toBe(false);
  });

  it.each([
    ["42P01 (undefined_table)", missingTable],
    ["PGRST205 (schema cache miss)", schemaCacheMiss],
  ])("reverseCommsCreditPoolForPaymentIntent returns false, never throws, on %s", async (_label, error) => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error }) }) }) }) };
    await expect(
      reverseCommsCreditPoolForPaymentIntent(db as never, "pi_test", "evt", { loadCharge: vi.fn() }),
    ).resolves.toBe(false);
  });

  it("reverseCommsCreditPoolForPaymentIntent still throws for a genuine database error", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: genuineError }) }) }) }) };
    await expect(
      reverseCommsCreditPoolForPaymentIntent(db as never, "pi_test", "evt", { loadCharge: vi.fn() }),
    ).rejects.toThrow("could not be verified");
  });

  it("fulfillCommsCreditPoolPurchase returns false on a missing table even for a matching purpose", async () => {
    const session = {
      id: "cs_test",
      mode: "payment",
      payment_status: "paid",
      currency: "usd",
      amount_subtotal: 500,
      amount_total: 500,
      payment_intent: "pi_test",
      client_reference_id: "funder-1",
      total_details: { amount_discount: 0 },
      metadata: {
        purpose: "manager_communication_credit_pool",
        manager_user_id: "funder-1",
        purchase_id: "11111111-1111-4111-8111-111111111111",
        credit_cents: "500",
      },
    } as unknown as Stripe.Checkout.Session;
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: missingTable }) }) }) }) };
    await expect(fulfillCommsCreditPoolPurchase(db as never, session, "evt")).resolves.toBe(false);
  });

  it("loadCommsPlanCreditRules (the admin Billing page's unconditional read) returns an empty list rather than throwing", async () => {
    const db = { from: () => ({ select: () => ({ order: async () => ({ data: null, error: missingTable }) }) }) };
    await expect(loadCommsPlanCreditRules(db as never)).resolves.toEqual([]);
  });
});
