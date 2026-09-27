import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  loadOrderedPoolFunders,
  reserveCommsCreditPool,
  setFunderFundingScope,
  setFunderWorkspaceMonthlyLimit,
  finishCommsCreditPool,
} from "@/lib/comms-billing/pool.server";
import { reserveCommsCredit, finishCommsCredit } from "@/lib/comms-billing/wallet.server";

const OWNER = "owner-uuid";
const MEMBER = "member-uuid";
const WORKSPACE = "workspace-uuid";

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
  it("flag off: reserveCommsCredit calls the legacy per-workspace RPC unchanged", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "");
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
});
