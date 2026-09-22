// A stale workspace cookie names a workspace row that no longer exists
// (deleted, or simply a leftover cookie from before a workspace was removed).
// resolveCreateListingOwner used to 403 outright in that case, blocking a
// manager from creating their own listing over nothing more than a dead
// cookie. It now falls back to the caller's own default workspace, mirroring
// the existing no-grant fallback (e8e31052 / PRP-481) — but only when the
// selection was ambient (the cookie), never when it was named explicitly in
// the request body (PRP-485).
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCreateListingOwner } from "@/lib/auth/workspace-add-property.server";

function mockDb(opts: {
  workspace?: { id: string; owner_user_id: string } | null;
  workspaceError?: { message: string } | null;
  ownDefaultWorkspaceId?: string;
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "portal_workspaces") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.workspace ?? null,
                error: opts.workspaceError ?? null,
              }),
            }),
          }),
        };
      }
      if (table === "account_link_invites") {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
            resolve({ data: [], error: null }),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string) => {
      if (fn === "ensure_default_portal_workspace") {
        return { data: opts.ownDefaultWorkspaceId ?? "own-ws-1", error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  } as unknown as SupabaseClient;
}

describe("resolveCreateListingOwner — stale workspace cookie (PRP-485)", () => {
  it("falls back to the caller's own default workspace when the ambient cookie names a workspace that no longer exists", async () => {
    const result = await resolveCreateListingOwner(mockDb({ workspace: null, ownDefaultWorkspaceId: "own-ws-9" }), {
      callerUserId: "manager-1",
      admin: false,
      requestedOwnerId: null,
      workspaceId: "deleted-ws",
    });
    expect(result).toEqual({
      ok: true,
      ownerUserId: "manager-1",
      workspaceId: "own-ws-9",
    });
  });

  it("still 403s when the missing workspace was named explicitly (e.g. in the request body)", async () => {
    const result = await resolveCreateListingOwner(mockDb({ workspace: null }), {
      callerUserId: "manager-1",
      admin: false,
      requestedOwnerId: null,
      workspaceId: "deleted-ws",
      explicitWorkspaceId: true,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });

  it("a workspace that DOES exist but carries no grant still refuses on a foreign, non-owned row (unchanged)", async () => {
    // Sanity check that this fix is scoped to a MISSING row — an existing,
    // foreign, ungranted workspace is a different branch entirely and must
    // keep behaving exactly as before this change.
    const result = await resolveCreateListingOwner(
      mockDb({ workspace: { id: "ws-1", owner_user_id: "owner-1" } }),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: null,
        workspaceId: "ws-1",
        explicitWorkspaceId: true,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });
});
