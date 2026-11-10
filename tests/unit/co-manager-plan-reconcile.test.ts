import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Revoking co-manager links is irreversible, and it runs on ordinary portal
 * reads through `syncManagerPurchaseTierState` — so it may only fire on a plan
 * that was positively read as free. An unreadable plan, or an account with no
 * committed SKU, must be a no-op rather than the harshest possible enforcement.
 */

const getManagerPurchaseSku = vi.fn();
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: (userId: string) => getManagerPurchaseSku(userId),
}));

const createSupabaseServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => createSupabaseServiceRoleClient(),
}));

function serviceClientWithInvites(rows: Array<Record<string, unknown>>) {
  const updated: string[] = [];
  const deleted: string[] = [];
  const sweepFilters: Array<Array<[string, string]>> = [];
  const client = {
    from(table: string) {
      if (table === "account_link_invites") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          or: () => Promise.resolve({ data: rows, error: null }),
          update: () => ({
            eq: (_col: string, id: string) => ({
              in: () => {
                updated.push(id);
                return Promise.resolve({ error: null });
              },
            }),
          }),
        };
        return builder;
      }
      return {
        delete: () => {
          const filters: Array<[string, string]> = [];
          const builder: Record<string, unknown> = {
            eq: (col: string, value: string) => {
              if (col === "id") {
                deleted.push(value);
                return Promise.resolve({ error: null });
              }
              return builder;
            },
            filter: (column: string, _op: string, value: string) => { filters.push([column, value]); return builder; },
            then: (resolve: (value: unknown) => void) => { sweepFilters.push(filters); return Promise.resolve({ error: null }).then(resolve); },
          };
          return builder;
        },
      };
    },
  };
  return { client, updated, deleted, sweepFilters };
}

describe("disconnectCoManagerLinksForPlanDowngrade", () => {
  beforeEach(() => {
    getManagerPurchaseSku.mockReset();
    createSupabaseServiceRoleClient.mockReset();
  });

  it("does nothing when the plan could not be read", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: null, readFailed: true });
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");

    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(0);
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("does nothing for an account with no committed SKU", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: null, readFailed: false });
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");

    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(0);
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("does nothing on a paid plan", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "pro", readFailed: false });
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");

    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(0);
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("revokes every link on a positively-read free plan", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "free", readFailed: false });
    const { client, updated, deleted } = serviceClientWithInvites([
      { id: "invite-1", inviter_user_id: "mgr-a", invitee_user_id: "mgr-b", status: "accepted", row_data: {} },
    ]);
    createSupabaseServiceRoleClient.mockReturnValue(client);
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");

    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(1);
    expect(updated).toEqual(["invite-1"]);
    expect(deleted).toEqual(["invite-1"]);
  });
  it("keeps another invite between the same participants when revoking one", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "free", readFailed: false });
    const { relationshipStorageId } = await import("@/lib/auth/pro-relationship-storage-id.server");
    const mirrorRows = ["invite-1", "invite-2"].flatMap((id) => [
      { id: relationshipStorageId("mgr-a", id), owner: "mgr-a", axis: "axis-b", invite: id },
      { id: relationshipStorageId("mgr-b", id), owner: "mgr-b", axis: "axis-a", invite: id },
    ]);
    const { client } = serviceClientWithInvites([
      { id: "invite-1", inviter_user_id: "mgr-a", invitee_user_id: "mgr-b", inviter_axis_id: "axis-a", invitee_axis_id: "axis-b", status: "accepted" },
    ]);
    const originalFrom = client.from;
    const scopedClient = { ...client, from: (table: string) => {
      if (table === "account_link_invites") return originalFrom(table);
      return { delete: () => {
        const tests: Array<(row: typeof mirrorRows[number]) => boolean> = [];
        const builder = {
          eq: (key: string, value: string) => { tests.push((row) => key === "id" ? row.id === value : row.owner === value); return builder; },
          filter: (key: string, _op: string, value: string) => { tests.push((row) => key === "row_data->>id" ? row.invite === value : row.axis === value); return builder; },
          then: (resolve: (value: unknown) => void) => {
            for (let i = mirrorRows.length - 1; i >= 0; i--) if (tests.every((test) => test(mirrorRows[i]!))) mirrorRows.splice(i, 1);
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return builder;
      } };
    } };
    createSupabaseServiceRoleClient.mockReturnValue(scopedClient);
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");
    await disconnectCoManagerLinksForPlanDowngrade("mgr-a");
    expect(mirrorRows.map((row) => row.invite)).toEqual(["invite-2", "invite-2"]);
  });
  it.each([
    ["pro", false, 0],
    ["free", false, 1],
    [null, true, 0],
  ])("preserves inherited Free invitees unless owner is positively Free (%s)", async (ownerTier, readFailed, expected) => {
    getManagerPurchaseSku.mockImplementation(async (id: string) => id === "mgr-a"
      ? { tier: "free", readFailed: false }
      : { tier: ownerTier, readFailed });
    const { client, updated } = serviceClientWithInvites([
      { id: "open-link", inviter_user_id: "owner", invitee_user_id: "mgr-a", status: "accepted", invitee_plan_inherited: true },
    ]);
    createSupabaseServiceRoleClient.mockReturnValue(client);
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");
    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(expected);
    expect(updated).toHaveLength(expected);
  });

  it("still revokes an inherited link when the inviter downgrades", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "free", readFailed: false });
    const { client, updated } = serviceClientWithInvites([
      { id: "open-link", inviter_user_id: "mgr-a", invitee_user_id: "other", status: "accepted", invitee_plan_inherited: true },
    ]);
    createSupabaseServiceRoleClient.mockReturnValue(client);
    const { disconnectCoManagerLinksForPlanDowngrade } = await import("@/lib/co-manager-plan-reconcile.server");
    expect(await disconnectCoManagerLinksForPlanDowngrade("mgr-a")).toBe(1);
    expect(updated).toEqual(["open-link"]);
  });

});
