import { describe, expect, it } from "vitest";
import {
  canActOnMember,
  describeHouseMove,
  effectiveHouseIds,
  memberReachLabel,
  memberStandingLabel,
  roleAssignableBy,
  workspaceRightsForMembership,
  workspaceRightsForRole,
} from "@/lib/workspaces/membership";
import { readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { inferTeamRoleFromPermissions, stampTeamRolePermissions, TEAM_ROLE_INVITE_OPTIONS, teamRoleListLabel } from "@/lib/co-manager-team-roles";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";

describe("workspace rights follow the role", () => {
  it("owner and admin run the workspace; property manager adds houses; the rest act only in their modules", () => {
    expect(workspaceRightsForRole("owner")).toEqual({ members: true, houses: true });
    expect(workspaceRightsForRole("admin")).toEqual({ members: true, houses: true });
    expect(workspaceRightsForRole("property_manager")).toEqual({ members: false, houses: true });
    for (const role of ["viewer", "leasing", "bookkeeper", "maintenance"] as const) {
      expect(workspaceRightsForRole(role)).toEqual({ members: false, houses: false });
    }
  });

  it("a Custom row keeps only the flags the owner set explicitly", () => {
    expect(workspaceRightsForMembership({ teamRole: "custom", workspacePermissions: {} })).toEqual({ members: false, houses: false });
    expect(workspaceRightsForMembership({ teamRole: "custom", workspacePermissions: { teams: true } })).toEqual({ members: true, houses: false });
    // A named role ignores stray flags: the role is the grant.
    expect(workspaceRightsForMembership({ teamRole: "viewer", workspacePermissions: { teams: true, addProperties: true } })).toEqual({ members: false, houses: false });
  });

  it("Full access reads as Admin and is not offered on a new invite", () => {
    expect(teamRoleListLabel("full")).toBe("Admin");
    expect(TEAM_ROLE_INVITE_OPTIONS.map((o) => o.value)).not.toContain("full");
    expect(TEAM_ROLE_INVITE_OPTIONS.map((o) => o.value)).toContain("admin");
    expect(inferTeamRoleFromPermissions(stampTeamRolePermissions("full")!)).toBe("admin");
  });
});

describe("who may act on whom", () => {
  it("the owner may act on anyone", () => {
    expect(canActOnMember({ actorRole: "owner", targetRole: "admin", adminCount: 1 })).toEqual({ ok: true });
  });
  it("an admin may act on members but never remove the last admin", () => {
    expect(canActOnMember({ actorRole: "admin", targetRole: "viewer", adminCount: 1 })).toEqual({ ok: true });
    expect(canActOnMember({ actorRole: "admin", targetRole: "admin", adminCount: 2 })).toEqual({ ok: true });
    expect(canActOnMember({ actorRole: "admin", targetRole: "admin", adminCount: 1 }).ok).toBe(false);
  });
  it("a viewer or leasing member may not act at all", () => {
    expect(canActOnMember({ actorRole: "viewer", targetRole: "viewer", adminCount: 3 }).ok).toBe(false);
    expect(canActOnMember({ actorRole: "leasing", targetRole: "viewer", adminCount: 3 }).ok).toBe(false);
  });
  it("an admin may stamp up to Admin; only the owner hands out the legacy full stamp", () => {
    expect(roleAssignableBy("admin", "admin")).toBe(true);
    expect(roleAssignableBy("admin", "viewer")).toBe(true);
    expect(roleAssignableBy("admin", "full")).toBe(false);
    expect(roleAssignableBy("owner", "full")).toBe(true);
    expect(roleAssignableBy("viewer", "viewer")).toBe(false);
  });
});

describe("what a membership reaches", () => {
  it("'all' is the workspace itself, houses added later included", () => {
    expect(effectiveHouseIds({ houseScope: "all", assignedPropertyIds: ["a"], workspacePropertyIds: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });
  it("'selected' is the list narrowed to the workspace, so a moved-out house is gone", () => {
    expect(effectiveHouseIds({ houseScope: "selected", assignedPropertyIds: ["a", "z"], workspacePropertyIds: ["a", "b"] })).toEqual(["a"]);
  });
  it("labels the reach the way the member row prints it", () => {
    expect(memberReachLabel({ houseScope: "all", houseCount: 10, workspaceHouseCount: 10 })).toBe("All houses");
    expect(memberReachLabel({ houseScope: "selected", houseCount: 3, workspaceHouseCount: 10 })).toBe("3 of 10 houses");
    expect(memberReachLabel({ houseScope: "selected", houseCount: 0, workspaceHouseCount: 10 })).toBe("No houses");
    expect(memberStandingLabel({ role: "owner", houseScope: "all", houseCount: 8, workspaceHouseCount: 8 })).toBe("Owner · 8 houses");
    expect(memberStandingLabel({ role: "leasing", houseScope: "selected", houseCount: 2, workspaceHouseCount: 6 })).toBe("Leasing · 2 of 6 houses");
  });
});

describe("an 'all houses' row grants its role on a house that joined later", () => {
  it("fills a missing per-house entry from the flat stamp and leaves an explicit narrower grant alone", () => {
    const stamp = stampTeamRolePermissions("leasing")!;
    const perms = readPropertyPermissionsFromRow({
      house_scope: "all",
      // The trigger appended `new-house`; the map has not seen it.
      assigned_property_ids: ["old-house", "new-house"],
      property_co_manager_permissions: { "old-house": { applications: { read: true } } },
      co_manager_permissions: stamp,
    });
    expect(coManagerModuleAllowed(perms, "new-house", "applications", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, "old-house", "applications", "edit")).toBe(false);
    expect(coManagerModuleAllowed(perms, "old-house", "applications", "read")).toBe(true);
  });
  it("never fills a 'selected' row — an empty entry there is still no access", () => {
    const perms = readPropertyPermissionsFromRow({
      house_scope: "selected",
      assigned_property_ids: ["h1"],
      property_co_manager_permissions: { h1: {} },
      co_manager_permissions: stampTeamRolePermissions("admin")!,
    });
    expect(coManagerModuleAllowed(perms, "h1", "properties", "read")).toBe(false);
  });
  it("falls back to the stored team_role's stamp when the flat grant is empty (a row from a redeemed link)", () => {
    const perms = readPropertyPermissionsFromRow({
      house_scope: "all",
      team_role: "admin",
      assigned_property_ids: ["old-house", "new-house"],
      property_co_manager_permissions: { "old-house": { properties: true } },
      co_manager_permissions: {},
    });
    expect(coManagerModuleAllowed(perms, "new-house", "properties", "edit")).toBe(true);
  });
  it("a 'selected' row is never filled from team_role either", () => {
    const perms = readPropertyPermissionsFromRow({
      house_scope: "selected",
      team_role: "admin",
      assigned_property_ids: ["h1"],
      property_co_manager_permissions: { h1: {} },
      co_manager_permissions: {},
    });
    expect(coManagerModuleAllowed(perms, "h1", "properties", "read")).toBe(false);
  });
});

describe("moving a house between workspaces", () => {
  const ana = { userId: "ana", name: "Ana Reyes" };
  const jordan = { userId: "jordan", name: "Jordan Kim" };
  const priya = { userId: "priya", name: "Priya Bhatt" };
  it("names who loses, keeps and gains before the move", () => {
    const result = describeHouseMove({
      propertyId: "oak",
      source: {
        members: [
          { ...ana, houseScope: "all", propertyIds: ["oak", "elm"] },
          { ...jordan, houseScope: "selected", propertyIds: ["oak"] },
          { ...priya, houseScope: "selected", propertyIds: ["elm"] },
        ],
      },
      destination: { members: [{ ...ana, houseScope: "all", propertyIds: ["pine"] }, { ...priya, houseScope: "all", propertyIds: ["pine"] }] },
    });
    expect(result).toEqual({ loses: ["Jordan Kim"], keeps: ["Ana Reyes"], gains: ["Priya Bhatt"] });
  });
});
