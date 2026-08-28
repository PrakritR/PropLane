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
          const builder: Record<string, unknown> = {
            eq: (col: string, value: string) => {
              if (col === "id") {
                deleted.push(value);
                return Promise.resolve({ error: null });
              }
              return builder;
            },
            filter: () => Promise.resolve({ error: null }),
          };
          return builder;
        },
      };
    },
  };
  return { client, updated, deleted };
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
});
