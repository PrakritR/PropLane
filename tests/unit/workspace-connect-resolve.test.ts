/**
 * `resolveWorkspaceConnectAccount` / `assertWorkspacePayoutAccess`
 * (workspace-connect/resolve.server.ts) — the server-side lookups behind the
 * per-workspace Connect architecture. The flag defaults off; with it off,
 * `resolveWorkspaceConnectAccount` must return null and touch the database
 * for nothing, so every existing caller (once wired) falls back to the
 * legacy per-manager Connect path unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbCalls: string[] = [];

/** A query-builder stub that is both directly awaitable (resolves `{ data }`) and chainable via `.eq()`/`.maybeSingle()`. */
function chain(data: unknown, next?: () => ReturnType<typeof chain>): PromiseLike<{ data: unknown }> & {
  eq: (...args: unknown[]) => ReturnType<typeof chain>;
  maybeSingle: () => Promise<{ data: unknown }>;
} {
  const self = {
    eq: (..._args: unknown[]) => (next ? next() : chain(data)),
    maybeSingle: async () => ({ data }),
    then: (onfulfilled: (value: { data: unknown }) => unknown) => Promise.resolve({ data }).then(onfulfilled),
  };
  return self as ReturnType<typeof chain>;
}

function fakeDb(rows: { workspace?: unknown; properties?: unknown[]; links?: unknown[] }) {
  return {
    from: (table: string) => {
      dbCalls.push(table);
      if (table === "portal_workspaces") {
        return { select: () => chain(rows.workspace ?? null) };
      }
      if (table === "manager_property_records") {
        return { select: () => chain(rows.properties ?? []) };
      }
      if (table === "account_link_invites") {
        // Three chained .eq() calls before the query resolves.
        return { select: () => chain(rows.links ?? [], () => chain(rows.links ?? [], () => chain(rows.links ?? []))) };
      }
      return { select: () => chain(null) };
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const ORIGINAL_ENV = process.env.WORKSPACE_CONNECT_ENABLED;

beforeEach(() => {
  dbCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_ENV === undefined) delete process.env.WORKSPACE_CONNECT_ENABLED;
  else process.env.WORKSPACE_CONNECT_ENABLED = ORIGINAL_ENV;
});

describe("resolveWorkspaceConnectAccount", () => {
  it("returns null and touches the database for nothing while the flag is off", async () => {
    vi.stubEnv("WORKSPACE_CONNECT_ENABLED", "");
    const { resolveWorkspaceConnectAccount } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({ workspace: { id: "ws-1", owner_user_id: "mgr-1" } });
    const result = await resolveWorkspaceConnectAccount(db, "ws-1");
    expect(result).toBeNull();
    expect(dbCalls).toHaveLength(0);
  });

  it("resolves the workspace's Connect account once the flag is on", async () => {
    vi.stubEnv("WORKSPACE_CONNECT_ENABLED", "1");
    const { resolveWorkspaceConnectAccount } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({
      workspace: {
        id: "ws-1",
        owner_user_id: "mgr-1",
        stripe_connect_account_id: "acct_1",
        stripe_connect_charges_enabled: true,
        stripe_connect_payouts_enabled: false,
        payout_mode: "manual",
      },
    });
    const result = await resolveWorkspaceConnectAccount(db, "ws-1");
    expect(result).toEqual({
      workspaceId: "ws-1",
      ownerUserId: "mgr-1",
      stripeConnectAccountId: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: false,
      payoutMode: "manual",
    });
  });

  it("returns null for an empty workspace id even with the flag on", async () => {
    vi.stubEnv("WORKSPACE_CONNECT_ENABLED", "1");
    const { resolveWorkspaceConnectAccount } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({ workspace: { id: "ws-1", owner_user_id: "mgr-1" } });
    expect(await resolveWorkspaceConnectAccount(db, "  ")).toBeNull();
  });
});

describe("assertWorkspacePayoutAccess", () => {
  it("the workspace owner always has access", async () => {
    vi.stubEnv("WORKSPACE_CONNECT_ENABLED", "1");
    const { assertWorkspacePayoutAccess } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({ workspace: { id: "ws-1", owner_user_id: "mgr-1" } });
    expect(await assertWorkspacePayoutAccess(db, "mgr-1", "ws-1")).toBe(true);
  });

  it("refuses a stranger with no accepted link to the owner", async () => {
    const { assertWorkspacePayoutAccess } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({ workspace: { id: "ws-1", owner_user_id: "mgr-1" }, properties: [{ id: "p-1" }], links: [] });
    expect(await assertWorkspacePayoutAccess(db, "co-1", "ws-1")).toBe(false);
  });

  it("refuses a missing workspace", async () => {
    const { assertWorkspacePayoutAccess } = await import("@/lib/workspace-connect/resolve.server");
    const db = fakeDb({ workspace: null });
    expect(await assertWorkspacePayoutAccess(db, "mgr-1", "ws-missing")).toBe(false);
  });
});
