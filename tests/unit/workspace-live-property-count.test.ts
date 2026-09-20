import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaces } from "@/lib/workspaces/server";

/**
 * A minimal thenable query-builder stub covering the chain shapes
 * `loadWorkspaces` uses (`select().eq().order()`, `select().eq().eq()`,
 * `select().in()`, …) without a real Supabase client.
 */
function chain(result: { data: unknown; error: unknown }) {
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    not: () => q,
    or: () => q,
    order: () => q,
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const OWNER = "mgr-live-count";
const WORKSPACE = "ws-live-count";

function mockDb(properties: Array<{ id: string; workspace_id: string; row_data: unknown; status: string }>): SupabaseClient {
  return {
    from(table: string) {
      if (table === "portal_workspaces") {
        return chain({
          data: [{ id: WORKSPACE, name: "My workspace", owner_user_id: OWNER, is_default: true }],
          error: null,
        });
      }
      // Both the invitee-side (`links`) and inviter-side (`grantsOut`) reads
      // land here; this fixture has no co-manager links at all.
      if (table === "account_link_invites") return chain({ data: [], error: null });
      if (table === "profiles") return chain({ data: [{ id: OWNER, email: "owner@test.local" }], error: null });
      if (table === "manager_property_records") return chain({ data: properties, error: null });
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("workspace live property count (PRP-481)", () => {
  it("counts only status=live while propertyIds keeps drafts and unlisted rows for scoping", async () => {
    const db = mockDb([
      { id: "p-live", workspace_id: WORKSPACE, row_data: { buildingName: "Live house" }, status: "live" },
      { id: "p-draft", workspace_id: WORKSPACE, row_data: { buildingName: "Draft house" }, status: "draft" },
      { id: "p-unlisted", workspace_id: WORKSPACE, row_data: { buildingName: "Unlisted house" }, status: "unlisted" },
    ]);

    const [workspace] = await loadWorkspaces(db, OWNER);

    expect(workspace?.propertyIds.sort()).toEqual(["p-draft", "p-live", "p-unlisted"]);
    expect(workspace?.livePropertyCount).toBe(1);
  });

  it("is zero when every record in the workspace is a draft or unlisted", async () => {
    const db = mockDb([
      { id: "p-draft", workspace_id: WORKSPACE, row_data: {}, status: "draft" },
      { id: "p-unlisted", workspace_id: WORKSPACE, row_data: {}, status: "unlisted" },
    ]);

    const [workspace] = await loadWorkspaces(db, OWNER);

    expect(workspace?.propertyIds).toHaveLength(2);
    expect(workspace?.livePropertyCount).toBe(0);
  });
});
