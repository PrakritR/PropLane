/**
 * Admin team (plan admin-team-1027): the pure rules. Who may grant what, the last-Overall-admin guard, the stored grant
 * shape, the request the sheet builds, the Settings scope dropdown and the PropLane-wide sidebar rows.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_TEAM_ROLE_OPTIONS,
  LAST_OVERALL_ADMIN_ERROR,
  NO_WORKSPACE_CHOSEN,
  ONLY_OVERALL_GRANTS_OVERALL,
  OVERALL_ADMIN_ROLE,
  WORKSPACE_NOT_YOURS,
  adminTeamAccessFields,
  adminTeamChangeRequest,
  adminTeamGrantVerdict,
  adminTeamInviteRequest,
  adminTeamRoleLabel,
  lastOverallAdminVerdict,
  normalizeAdminInviteEmail,
  parseAdminTeamRole,
  parseStoredAdminGrant,
  type AdminTeamActor,
} from "@/lib/admin-team/admin-team-model";
import { ADMIN_NAV_ROW_ORDER, adminNavRowsForViewer } from "@/lib/portals/nav-groups";
import { PROPLANE_SCOPE_VALUE, settingsScopeOptions, settingsScopeTarget, settingsScopeValue, type SettingsScope } from "@/lib/admin-team/settings-scope";
import { TEAM_ROLE_INVITE_OPTIONS } from "@/lib/co-manager-team-roles";

const overall: AdminTeamActor = { overall: true, manageableWorkspaceIds: new Set(["ws-a", "ws-b"]) };
const workspaceAdmin: AdminTeamActor = { overall: false, manageableWorkspaceIds: new Set(["ws-a"]) };
const nobody: AdminTeamActor = { overall: false, manageableWorkspaceIds: new Set() };

describe("roles", () => {
  it("offers Overall admin first, then the manager Team invite's roles, with Admin read as Workspace admin", () => {
    expect(ADMIN_TEAM_ROLE_OPTIONS[0]).toEqual({ value: OVERALL_ADMIN_ROLE, label: "Overall admin" });
    expect(ADMIN_TEAM_ROLE_OPTIONS.slice(1).map((o) => o.value)).toEqual(TEAM_ROLE_INVITE_OPTIONS.map((o) => o.value));
    expect(ADMIN_TEAM_ROLE_OPTIONS.find((o) => o.value === "admin")?.label).toBe("Workspace admin");
    expect(adminTeamRoleLabel("full")).toBe("Workspace admin");
    expect(adminTeamRoleLabel("property_manager")).toBe("Property manager");
  });

  it("parses a role from the allow-list only, and never the owner of record", () => {
    expect(parseAdminTeamRole("overall_admin")).toBe("overall_admin");
    expect(parseAdminTeamRole("bookkeeper")).toBe("bookkeeper");
    expect(parseAdminTeamRole("property_owner")).toBeNull();
    expect(parseAdminTeamRole("root")).toBeNull();
    expect(parseAdminTeamRole(undefined)).toBeNull();
  });

  it("normalizes the bound email", () => {
    expect(normalizeAdminInviteEmail("  Aarav@Example.COM ")).toBe("aarav@example.com");
    expect(normalizeAdminInviteEmail("not-an-email")).toBeNull();
    expect(normalizeAdminInviteEmail(42)).toBeNull();
  });
});

describe("who may grant what (decision 1)", () => {
  it("only an Overall admin can grant Overall admin", () => {
    expect(adminTeamGrantVerdict(overall, { role: "overall_admin", workspaceIds: [] })).toEqual({ ok: true });
    expect(adminTeamGrantVerdict(workspaceAdmin, { role: "overall_admin", workspaceIds: [] })).toEqual({
      ok: false,
      status: 403,
      error: ONLY_OVERALL_GRANTS_OVERALL,
    });
  });

  it("a workspace admin grants only inside the workspaces they manage", () => {
    expect(adminTeamGrantVerdict(workspaceAdmin, { role: "property_manager", workspaceIds: ["ws-a"] })).toEqual({ ok: true });
    expect(adminTeamGrantVerdict(workspaceAdmin, { role: "property_manager", workspaceIds: ["ws-a", "ws-b"] })).toMatchObject({
      ok: false,
      status: 403,
      error: WORKSPACE_NOT_YOURS,
    });
    expect(adminTeamGrantVerdict(workspaceAdmin, { role: "viewer", workspaceIds: ["ws-b"] })).toMatchObject({ ok: false, status: 403 });
  });

  it("a workspace role needs at least one workspace, and a viewer who manages none grants nothing", () => {
    expect(adminTeamGrantVerdict(overall, { role: "viewer", workspaceIds: [] })).toMatchObject({ ok: false, status: 400, error: NO_WORKSPACE_CHOSEN });
    expect(adminTeamGrantVerdict(nobody, { role: "viewer", workspaceIds: ["ws-a"] })).toMatchObject({ ok: false, status: 403 });
    expect(adminTeamGrantVerdict(nobody, { role: "overall_admin", workspaceIds: [] })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("the last Overall admin", () => {
  it("cannot be removed or demoted; with another admin it can", () => {
    expect(lastOverallAdminVerdict(["a"], "a")).toEqual({ ok: false, status: 409, error: LAST_OVERALL_ADMIN_ERROR });
    expect(lastOverallAdminVerdict(["a", "b"], "a")).toEqual({ ok: true });
    expect(lastOverallAdminVerdict(["a"], "someone-else")).toEqual({ ok: true });
    expect(lastOverallAdminVerdict([], "a")).toMatchObject({ ok: false });
  });
});

describe("the grant an admin invite stores", () => {
  it("reads back a role and its workspaces, and drops workspaces from an Overall grant", () => {
    expect(parseStoredAdminGrant({ role: "overall_admin", workspaceIds: ["x"], access: {} })).toEqual({ role: "overall_admin", workspaceIds: [], access: {} });
    expect(parseStoredAdminGrant({ role: "viewer", workspaceIds: ["w1", "w1", " w2 "], access: { houseScope: "all" } })).toEqual({
      role: "viewer",
      workspaceIds: ["w1", "w2"],
      access: { houseScope: "all" },
    });
  });

  it("reads anything malformed as no grant (the redeem then refuses)", () => {
    expect(parseStoredAdminGrant(null)).toBeNull();
    expect(parseStoredAdminGrant([])).toBeNull();
    expect(parseStoredAdminGrant({ role: "viewer", workspaceIds: [] })).toBeNull();
    expect(parseStoredAdminGrant({ role: "god", workspaceIds: ["w1"] })).toBeNull();
  });
});

describe("the requests the sheet builds", () => {
  const base = { role: "property_manager" as const, workspaceIds: ["ws-a"], houseScope: "all" as const, houseIds: [], customPermissions: {}, workspacePermissions: {} };

  it("an Overall admin invite names no workspace and no access", () => {
    expect(adminTeamInviteRequest({ email: " a@b.co ", choice: { ...base, role: "overall_admin" } })).toEqual({
      email: "a@b.co",
      role: "overall_admin",
      workspaceIds: [],
      access: {},
    });
  });

  it("'all houses' across several workspaces names no house, so each resolves its own", () => {
    const fields = adminTeamAccessFields({ ...base, workspaceIds: ["ws-a", "ws-b"], houseScope: "selected", houseIds: ["h1"] });
    expect(fields).toEqual({ teamRole: "property_manager", houseScope: "all" });
  });

  it("a selected list is sent only for exactly one workspace", () => {
    expect(adminTeamAccessFields({ ...base, houseScope: "selected", houseIds: ["h1", "h2"] })).toEqual({
      teamRole: "property_manager",
      houseScope: "selected",
      assignedPropertyIds: ["h1", "h2"],
    });
  });

  it("a Custom role carries its grid and workspace rights; a named role carries neither", () => {
    const custom = adminTeamAccessFields({ ...base, role: "custom", customPermissions: { inbox: true }, workspacePermissions: { members: true } });
    expect(custom).toMatchObject({ teamRole: "custom", coManagerPermissions: { inbox: true }, workspacePermissions: { members: true } });
    expect(adminTeamAccessFields(base)).not.toHaveProperty("coManagerPermissions");
  });

  it("a change request names the person by id and the same role / workspaces / access", () => {
    expect(adminTeamChangeRequest({ userId: "u1", choice: base })).toEqual({
      userId: "u1",
      role: "property_manager",
      workspaceIds: ["ws-a"],
      access: { teamRole: "property_manager", houseScope: "all" },
    });
  });
});

describe("PropLane-wide sidebar rows", () => {
  it("an Overall admin sees every row; a workspace admin sees none of them", () => {
    expect(adminNavRowsForViewer({ overall: true })).toEqual(ADMIN_NAV_ROW_ORDER);
    expect(adminNavRowsForViewer({ overall: false })).toEqual([]);
  });
});

describe("Settings scope dropdown", () => {
  const workspaces = [
    { id: "ws-a", name: "1. Ambika", city: "Seattle" },
    { id: "ws-b", name: "2. Vinod", city: null },
  ];
  const adminOnProLane: SettingsScope = { overall: true, workspaces, currentWorkspaceId: null };
  const adminInAmbika: SettingsScope = { overall: true, workspaces, currentWorkspaceId: "ws-a" };
  const seatHolder: SettingsScope = { overall: false, workspaces: [workspaces[0]!], currentWorkspaceId: "ws-a" };

  it("lists PropLane first for an Overall admin, then each workspace; a workspace admin sees only theirs", () => {
    expect(settingsScopeOptions(adminOnProLane).map((o) => o.label)).toEqual(["PropLane", "1. Ambika · Seattle", "2. Vinod"]);
    expect(settingsScopeOptions(seatHolder).map((o) => o.value)).toEqual(["ws-a"]);
  });

  it("starts on whichever scope the viewer came from", () => {
    expect(settingsScopeValue(adminOnProLane)).toBe(PROPLANE_SCOPE_VALUE);
    expect(settingsScopeValue(adminInAmbika)).toBe("ws-a");
  });

  it("switching to a workspace opens it and stays in Settings; to PropLane returns to PropLane Settings; same scope stays put", () => {
    expect(settingsScopeTarget(adminOnProLane, "ws-b")).toEqual({ kind: "workspace", workspaceId: "ws-b", href: "/portal/profile?tab=workspaces" });
    expect(settingsScopeTarget(adminInAmbika, PROPLANE_SCOPE_VALUE)).toEqual({ kind: "proplane", href: "/admin/profile?tab=profile" });
    expect(settingsScopeTarget(adminInAmbika, "ws-a")).toEqual({ kind: "stay" });
  });

  it("never switches to a workspace the viewer cannot open, or to PropLane without the Overall role", () => {
    expect(settingsScopeTarget(seatHolder, "ws-b")).toEqual({ kind: "stay" });
    expect(settingsScopeTarget(seatHolder, PROPLANE_SCOPE_VALUE)).toEqual({ kind: "stay" });
  });
});
