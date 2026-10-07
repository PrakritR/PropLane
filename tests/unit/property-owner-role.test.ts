/**
 * Property owner is a team role, not a portal: a stamp plus a label, with a
 * different permission vocabulary (four owner keys) and no workspace rights.
 * These pin the role's shape so a later edit cannot widen it quietly.
 */
import { describe, expect, it } from "vitest";

import {
  CO_MANAGER_PERMISSION_OPTIONS,
  OWNER_PERMISSION_OPTIONS,
  hasCoManagerPermissionLevel,
  normalizeCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  TEAM_ROLE_IDS,
  TEAM_ROLE_INVITE_OPTIONS,
  TEAM_ROLE_LABELS,
  applyRoleToPropertyPermissions,
  inferInviteTeamRole,
  inferTeamRoleFromPermissions,
  parseTeamRole,
  permissionsForRole,
  permissionsMatchTeamRole,
  stampTeamRolePermissions,
  stampTeamRoleOnProperties,
  withoutOwnerLinks,
} from "@/lib/co-manager-team-roles";
import { canActOnMember, canManageWorkspaceMembers, roleAssignableBy, workspaceRightsForMembership, workspaceRightsForRole } from "@/lib/workspaces/membership";

const OFF = { notification: false } as const;

describe("the Property owner role", () => {
  it("is the first option in the Role dropdown, labelled Property owner", () => {
    expect(TEAM_ROLE_INVITE_OPTIONS[0]).toEqual({ value: "property_owner", label: "Property owner" });
    expect(TEAM_ROLE_IDS[0]).toBe("property_owner");
    expect(TEAM_ROLE_LABELS.property_owner).toBe("Property owner");
    expect(parseTeamRole("property_owner")).toEqual({ ok: true, role: "property_owner" });
  });

  it("stamps the owner keys at View, Messages off, and no module at all", () => {
    const stamp = stampTeamRolePermissions("property_owner")!;
    for (const id of ["ownerPerformance", "ownerStatements", "ownerDocuments"] as const) {
      expect(hasCoManagerPermissionLevel(stamp, id, "read"), id).toBe(true);
      expect(hasCoManagerPermissionLevel(stamp, id, "edit"), id).toBe(false);
      expect(hasCoManagerPermissionLevel(stamp, id, "delete"), id).toBe(false);
    }
    expect(hasCoManagerPermissionLevel(stamp, "ownerMessages", "read")).toBe(false);
    for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
      expect(hasCoManagerPermissionLevel(stamp, id, "read"), `module ${id}`).toBe(false);
    }
  });

  it("has explicit workspace rights of none: no members, no houses", () => {
    expect(workspaceRightsForRole("property_owner")).toEqual({ members: false, houses: false });
    expect(workspaceRightsForMembership({ teamRole: "property_owner", workspacePermissions: { teams: true, addProperties: true } })).toEqual({
      members: false,
      houses: false,
    });
    expect(canManageWorkspaceMembers("property_owner")).toBe(false);
  });

  it("cannot edit or remove a member, and cannot hand out any role", () => {
    expect(canActOnMember({ actorRole: "property_owner", targetRole: "viewer", adminCount: 2 }).ok).toBe(false);
    for (const role of TEAM_ROLE_IDS) expect(roleAssignableBy("property_owner", role), role).toBe(false);
  });

  it("is never inferred from a map: an empty or owner-only map is not evidence of an owner", () => {
    expect(inferTeamRoleFromPermissions({})).toBe("custom");
    expect(inferTeamRoleFromPermissions(stampTeamRolePermissions("property_owner")!)).toBe("custom");
    expect(inferInviteTeamRole({ a: {} })).toBe("custom");
  });

  it("matches its own role for any owner-key combination, but never with a module grant", () => {
    expect(permissionsMatchTeamRole({ ownerMessages: { read: true } }, "property_owner")).toBe(true);
    expect(permissionsMatchTeamRole({ ownerPerformance: OFF }, "property_owner")).toBe(true);
    expect(permissionsMatchTeamRole({ ownerPerformance: { read: true }, financials: { read: true } }, "property_owner")).toBe(false);
  });
});

describe("owner keys are confined to the owner role", () => {
  it("are not in the module list, so no module loop can stamp or show them", () => {
    const moduleIds = new Set<string>(CO_MANAGER_PERMISSION_OPTIONS.map((o) => o.id));
    for (const { id } of OWNER_PERMISSION_OPTIONS) expect(moduleIds.has(id)).toBe(false);
    for (const role of TEAM_ROLE_IDS) {
      if (role === "custom" || role === "property_owner") continue;
      const stamp = stampTeamRolePermissions(role)!;
      for (const { id } of OWNER_PERMISSION_OPTIONS) expect(stamp[id], `${role}.${id}`).toBeUndefined();
    }
  });

  it("round-trip through normalization, including an explicit off", () => {
    const normalized = normalizeCoManagerPermissions({ ownerPerformance: true, ownerMessages: OFF, bogus: true });
    expect(normalized.ownerPerformance).toBe(true);
    expect(normalized.ownerMessages).toEqual(OFF);
    expect(hasCoManagerPermissionLevel(normalized, "ownerMessages", "read")).toBe(false);
    expect((normalized as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("a role write drops a forged module grant from an owner and any owner key from everyone else", () => {
    const forged: CoManagerPermissions = { ownerStatements: { read: true }, financials: true, residents: true };
    expect(permissionsForRole("property_owner", forged)).toEqual({ ownerStatements: { read: true } });
    expect(permissionsForRole("viewer", forged)).toEqual({ financials: true, residents: true });
    expect(applyRoleToPropertyPermissions("property_owner", { h1: forged })).toEqual({ h1: { ownerStatements: { read: true } } });
  });

  it("stamping an owner keeps the keys the manager set and defaults only when none are set", () => {
    const set = stampTeamRoleOnProperties("property_owner", ["h1", "h2"], {
      h1: { ownerPerformance: { read: true, notification: true }, ownerMessages: { read: true, notification: true }, ownerStatements: OFF },
      h2: {},
    });
    expect(set.h1).toEqual({ ownerPerformance: { read: true, notification: true }, ownerMessages: { read: true, notification: true }, ownerStatements: OFF });
    // No owner key set at all: the default (Messages off).
    expect(hasCoManagerPermissionLevel(set.h2, "ownerPerformance", "read")).toBe(true);
    expect(hasCoManagerPermissionLevel(set.h2, "ownerMessages", "read")).toBe(false);
    // A module grant on an owner map is not carried into a stamp.
    const forged = stampTeamRoleOnProperties("property_owner", ["h1"], { h1: { financials: true } });
    expect(hasCoManagerPermissionLevel(forged.h1, "financials", "read")).toBe(false);
  });
});

describe("withoutOwnerLinks", () => {
  it("drops owner rows and keeps legacy NULL-role rows", () => {
    const out = withoutOwnerLinks({
      data: [{ team_role: "property_owner" }, { team_role: null }, { team_role: "viewer" }, { id: "no-role-column" }],
    });
    expect(out.data).toHaveLength(3);
    expect(out.data.some((r) => (r as { team_role?: string }).team_role === "property_owner")).toBe(false);
  });

  it("passes a non-array result through", () => {
    expect(withoutOwnerLinks({ data: null }).data).toBeNull();
  });
});
