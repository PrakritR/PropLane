import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCreateListingOwner } from "@/lib/auth/workspace-add-property.server";

function mockDb(opts: {
  workspace?: { id: string; owner_user_id: string } | null;
  workspaceError?: { message: string } | null;
  links?: Array<{ id: string; workspace_id?: string | null; workspace_permissions?: unknown }>;
  linksError?: { message: string } | null;
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
  } as unknown as SupabaseClient;
}

describe("resolveCreateListingOwner", () => {
  it("refuses a non-admin foreign owner even when no workspace was selected", async () => {
    const result = await resolveCreateListingOwner(mockDb({}), {
      callerUserId: "manager-1",
      admin: false,
      requestedOwnerId: "manager-2",
      workspaceId: null,
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });

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

  it("refuses a teammate without addProperties", async () => {
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

  it("refuses a contradictory foreign owner even when the caller selected their own workspace", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({ workspace: { id: "ws-1", owner_user_id: "owner-1" } }),
      {
        callerUserId: "owner-1",
        admin: false,
        requestedOwnerId: "unrelated-1",
        workspaceId: "ws-1",
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });

  it("refuses a contradictory foreign owner on an accepted shared workspace", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({
        workspace: { id: "ws-1", owner_user_id: "owner-1" },
        links: [{ id: "invite-1", workspace_id: "ws-1", workspace_permissions: { addProperties: true } }],
      }),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: "unrelated-1",
        workspaceId: "ws-1",
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });

  it("allows the caller's incidental owner id when an accepted workspace derives the real owner", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({
        workspace: { id: "ws-1", owner_user_id: "owner-1" },
        links: [{ id: "invite-1", workspace_id: "ws-1", workspace_permissions: { addProperties: true } }],
      }),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: "co-1",
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

  it("refuses a non-admin naming another owner without a selected workspace", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({}),
      {
        callerUserId: "co-1",
        admin: false,
        requestedOwnerId: "owner-1",
        workspaceId: null,
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Select an owned workspace before adding a property.",
    });
  });

  it("keeps self-create available without a selected workspace", async () => {
    const result = await resolveCreateListingOwner(
      mockDb({}),
      {
        callerUserId: "owner-1",
        admin: false,
        requestedOwnerId: "owner-1",
        workspaceId: null,
      },
    );

    expect(result).toEqual({ ok: true, ownerUserId: "owner-1" });
  });

  it("the property-records route appends the new listing onto the teammate invite", () => {
    const route = readFileSync("src/app/api/property-records/route.ts", "utf8");
    expect(route).toContain("appendCreatedListingToInviteId = created.appendToInviteId");
    expect(route).toContain("assigned_property_ids: nextAssigned");
    expect(route).toContain("property_co_manager_permissions: nextPerms");
  });
});
