import { describe, expect, it, vi } from "vitest";

/**
 * `GET /api/pro/account-links` (route.ts ~207-215) refuses to disclose an
 * invitee's email/phone on an outgoing PENDING invite: creating one needs
 * only the target's PropLane ID, the invitee never consented, and the
 * inviter is the one already looking at their own outgoing row — so contact
 * details are withheld until the invite is accepted. `loadWorkspaces`'
 * member list is the same viewer (the workspace's owner/admin, looking at
 * their own invite), so it must mirror that rule exactly rather than
 * emitting the live profile's email and name for every row regardless of
 * status (security review: pending-invite-email-disclosed-in-workspaces).
 */
import { loadWorkspaces } from "@/lib/workspaces/server";

const OWNER = "owner-1";
const WORKSPACE_ID = "ws-1";

function dbFor(config: {
  membershipRows: Record<string, unknown>[];
  inviteeProfiles: { id: string; full_name: string | null; email: string | null }[];
}) {
  let accountLinkInvitesCalls = 0;
  let profilesCalls = 0;
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = vi.fn(() => q);
      q.eq = vi.fn(() => q);
      q.in = vi.fn(() => q);
      q.not = vi.fn(() => q);
      q.or = vi.fn(() => q);
      q.order = vi.fn(() => q);
      q.then = (resolve: (value: unknown) => unknown) => {
        if (table === "portal_workspaces") {
          return Promise.resolve({
            data: [{ id: WORKSPACE_ID, name: "Acme Portfolio", owner_user_id: OWNER, is_default: true }],
            error: null,
          }).then(resolve);
        }
        if (table === "account_link_invites") {
          accountLinkInvitesCalls += 1;
          // Call 1: the viewer's OWN accepted memberships elsewhere — none here.
          // Call 2: every membership row (accepted + pending) this workspace holds.
          const data = accountLinkInvitesCalls === 1 ? [] : config.membershipRows;
          return Promise.resolve({ data, error: null }).then(resolve);
        }
        if (table === "profiles") {
          profilesCalls += 1;
          // Call 1: participant emails (sandbox-pair check) — just the owner.
          // Call 2: live invitee profiles (full_name, email) for the members list.
          const data =
            profilesCalls === 1
              ? [{ id: OWNER, email: "owner@test.proplane.local" }]
              : config.inviteeProfiles;
          return Promise.resolve({ data, error: null }).then(resolve);
        }
        if (table === "manager_property_records") {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        }
        throw new Error(`unexpected workspaces table: ${table}`);
      };
      return q;
    },
  };
}

describe("loadWorkspaces member disclosure mirrors the outgoing-pending-invite rule", () => {
  it("a pending row carries no email and only the invite-time display name, never the live profile", async () => {
    const workspaces = await loadWorkspaces(
      dbFor({
        membershipRows: [
          {
            id: "link-pending",
            inviter_user_id: OWNER,
            invitee_user_id: "invitee-pending",
            invitee_display_name: "Jamie Rivera",
            assigned_property_ids: [],
            property_co_manager_permissions: {},
            co_manager_permissions: {},
            workspace_id: WORKSPACE_ID,
            workspace_permissions: {},
            legacy_workspace_permissions: {},
            team_role: "viewer",
            house_scope: "all",
            status: "pending",
            responded_at: null,
          },
          {
            id: "link-accepted",
            inviter_user_id: OWNER,
            invitee_user_id: "invitee-accepted",
            invitee_display_name: "Stale Snapshot Name",
            assigned_property_ids: [],
            property_co_manager_permissions: {},
            co_manager_permissions: {},
            workspace_id: WORKSPACE_ID,
            workspace_permissions: {},
            legacy_workspace_permissions: {},
            team_role: "viewer",
            house_scope: "all",
            status: "accepted",
            responded_at: "2026-01-01T00:00:00Z",
          },
        ],
        inviteeProfiles: [
          // If the pending row ever read this live profile, the test would see
          // this name/email leak through instead of the invite-time snapshot.
          { id: "invitee-pending", full_name: "Real Name Should Not Leak", email: "leak@test.proplane.local" },
          { id: "invitee-accepted", full_name: "Accepted Person", email: "accepted@test.proplane.local" },
        ],
      }) as never,
      OWNER,
    );

    const workspace = workspaces.find((w) => w.id === WORKSPACE_ID);
    expect(workspace).toBeTruthy();
    const members = workspace!.members ?? [];

    const pending = members.find((m) => m.userId === "invitee-pending");
    expect(pending).toBeTruthy();
    expect(pending!.status).toBe("pending");
    expect(pending!.email).toBe("");
    expect(pending!.name).toBe("Jamie Rivera");
    expect(pending!.name).not.toContain("Real Name Should Not Leak");

    const accepted = members.find((m) => m.userId === "invitee-accepted");
    expect(accepted).toBeTruthy();
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.email).toBe("accepted@test.proplane.local");
    expect(accepted!.name).toBe("Accepted Person");
  });

  it("a pending row with no invite-time snapshot name falls back to a generic label, not the live profile", async () => {
    const workspaces = await loadWorkspaces(
      dbFor({
        membershipRows: [
          {
            id: "link-pending-2",
            inviter_user_id: OWNER,
            invitee_user_id: "invitee-pending-2",
            invitee_display_name: null,
            assigned_property_ids: [],
            property_co_manager_permissions: {},
            co_manager_permissions: {},
            workspace_id: WORKSPACE_ID,
            workspace_permissions: {},
            legacy_workspace_permissions: {},
            team_role: "viewer",
            house_scope: "all",
            status: "pending",
            responded_at: null,
          },
        ],
        inviteeProfiles: [
          { id: "invitee-pending-2", full_name: "Should Still Not Leak", email: "leak2@test.proplane.local" },
        ],
      }) as never,
      OWNER,
    );

    const member = workspaces.find((w) => w.id === WORKSPACE_ID)?.members?.[0];
    expect(member).toBeTruthy();
    expect(member!.email).toBe("");
    expect(member!.name).toBe("Team member");
  });
});
