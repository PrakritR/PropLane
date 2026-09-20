import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCreateListingOwner } from "@/lib/auth/workspace-add-property.server";

function mockDb(opts: {
  workspace?: { id: string; owner_user_id: string } | null;
  workspaceError?: { message: string } | null;
  links?: Array<{ id: string; workspace_id?: string | null; workspace_permissions?: unknown }>;
  linksError?: { message: string } | null;
  /** The caller's own default workspace id, returned by `ensure_default_portal_workspace`. */
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
            resolve({ data: opts.links ?? [], error: opts.linksError ?? null }),
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

describe("resolveCreateListingOwner", () => {
  it("stamps a teammate listing as the workspace owner when addProperties is granted", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({
        workspace: { id: "ws-1", owner_user_id: "owner-1" },
        links: [{ id: "invite-1", workspace_id: "ws-1", workspace_permissions: { addProperties: true } }],
      }),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: null,
        workspaceId: "ws-1",
      },
    );
    expect(result).toEqual({
      ok: true,
      ownerUserId: "owner-1",
      workspaceId: "ws-1",
      appendToInviteId: "invite-1",
    });
  });

  it("self-owned create from a non-owned selected workspace resolves to the caller's own workspace (PRP-481)", async () => {
    // co-1's ambient (cookie) selection is ws-1, owned by someone else, with no
    // addProperties grant — a stale cookie must not block a self-owned create.
    const result = await resolveCreateListingOwner(
      mockDb({
        workspace: { id: "ws-1", owner_user_id: "owner-1" },
        links: [{ id: "invite-1", workspace_id: "ws-1", workspace_permissions: { teams: true } }],
        ownDefaultWorkspaceId: "own-ws-1",
      }),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: null,
        workspaceId: "ws-1",
      },
    );
    expect(result).toEqual({
      ok: true,
      ownerUserId: "co-1",
      workspaceId: "own-ws-1",
    });
  });

  it("a body workspaceId the caller doesn't own still 403s (PRP-481)", async () => {
    // Same non-owned, no-grant workspace, but named explicitly (e.g. in the
    // request body) rather than the ambient cookie selection — refuse rather
    // than silently substitute a different workspace.
    const result = await resolveCreateListingOwner(
      mockDb({
        workspace: { id: "ws-1", owner_user_id: "owner-1" },
        links: [{ id: "invite-1", workspace_id: "ws-1", workspace_permissions: { teams: true } }],
      }),
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

  it("lets the owner create into their own workspace", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({ workspace: { id: "ws-1", owner_user_id: "owner-1" } }),
      {
        callerUserId: "owner-1",
        admin: false,
        requestedOwnerId: null,
        workspaceId: "ws-1",
      },
    );
    expect(result).toEqual({
      ok: true,
      ownerUserId: "owner-1",
      workspaceId: "ws-1",
    });
  });

  it("the property-records route appends the new listing onto the teammate invite", () => {
    const route = readFileSync("src/app/api/property-records/route.ts", "utf8");
    expect(route).toContain("appendCreatedListingToInviteId = created.appendToInviteId");
    expect(route).toContain("assigned_property_ids: nextAssigned");
    expect(route).toContain("property_co_manager_permissions: nextPerms");
  });

  it("the property-records route marks a body-named workspace explicit and a cookie selection ambient", () => {
    const route = readFileSync("src/app/api/property-records/route.ts", "utf8");
    expect(route).toContain("explicitWorkspaceId: bodyWorkspaceId.length > 0");
    expect(route).toContain("workspaceId: bodyWorkspaceId || readWorkspaceCookie(req.headers.get(\"cookie\")) || null");
  });
});
