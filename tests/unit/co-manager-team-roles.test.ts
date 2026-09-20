import { describe, expect, it } from "vitest";
import {
  coManagerModuleAllowed,
  normalizePropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  inferTeamRoleFromPermissions,
  parseTeamRole,
  permissionsMatchTeamRole,
  stampTeamRoleOnProperties,
  stampTeamRolePermissions,
  teamRoleListLabel,
  UNKNOWN_TEAM_ROLE_ERROR,
} from "@/lib/co-manager-team-roles";

const HOUSE = "prop-1";

describe("stampTeamRolePermissions", () => {
  it("Viewer stamps every module View + notify", () => {
    const stamp = stampTeamRolePermissions("viewer");
    expect(stamp).not.toBeNull();
    expect(permissionsMatchTeamRole(stamp!, "viewer")).toBe(true);
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments", "edit")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount", "delete")).toBe(false);
  });

  it("Leasing stamps Applications / Promotion / Communication / Calendar Edit and Properties / Residents / Leases View", () => {
    const stamp = stampTeamRolePermissions("leasing")!;
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "applications", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "promotion", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "inbox", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "calendar", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "properties")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "residents")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "leases")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "teams")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "financials")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "services")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "documents")).toBe(false);
  });

  it("Property manager stamps operations Edit, money View, bank none", () => {
    const stamp = stampTeamRolePermissions("property_manager")!;
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "properties", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "services", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "documents", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments", "edit")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "financials")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "teams")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount")).toBe(false);
  });

  it("Bookkeeper stamps Payments / Documents / Finances Edit and Properties + Bank View", () => {
    const stamp = stampTeamRolePermissions("bookkeeper")!;
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "documents", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "financials", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "properties")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount", "edit")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "applications")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "teams")).toBe(false);
  });

  it("Maintenance stamps Services / Communication / Calendar Edit and Properties View", () => {
    const stamp = stampTeamRolePermissions("maintenance")!;
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "services", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "inbox", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "calendar", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "properties")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "teams")).toBe(false);
  });

  it("Full access stamps every module Manage", () => {
    const stamp = stampTeamRolePermissions("full")!;
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: stamp }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount", "delete")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "teams", "delete")).toBe(true);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments", "delete")).toBe(true);
  });

  it("Custom is not a stamp", () => {
    expect(stampTeamRolePermissions("custom")).toBeNull();
  });

  it("stamps every assigned house and leaves Custom maps alone", () => {
    const current = { [HOUSE]: { payments: true } };
    expect(stampTeamRoleOnProperties("custom", [HOUSE, "prop-2"], current)).toBe(current);
    const next = stampTeamRoleOnProperties("viewer", [HOUSE, "prop-2"], current);
    expect(permissionsMatchTeamRole(next[HOUSE]!, "viewer")).toBe(true);
    expect(permissionsMatchTeamRole(next["prop-2"]!, "viewer")).toBe(true);
  });
});

describe("parseTeamRole", () => {
  it("accepts every product role id", () => {
    expect(parseTeamRole("leasing")).toEqual({ ok: true, role: "leasing" });
    expect(parseTeamRole("property_manager")).toEqual({ ok: true, role: "property_manager" });
    expect(parseTeamRole(null)).toEqual({ ok: true, role: null });
    expect(parseTeamRole("")).toEqual({ ok: true, role: null });
  });

  it("refuses unknown ids", () => {
    expect(parseTeamRole("admin")).toEqual({ ok: false, error: UNKNOWN_TEAM_ROLE_ERROR });
    expect(parseTeamRole(12)).toEqual({ ok: false, error: UNKNOWN_TEAM_ROLE_ERROR });
  });
});

describe("infer + label", () => {
  it("infers Leasing from its stamp and Custom after a tweak", () => {
    const leasing = stampTeamRolePermissions("leasing")!;
    expect(inferTeamRoleFromPermissions(leasing)).toBe("leasing");
    expect(inferTeamRoleFromPermissions({ ...leasing, payments: { read: true, edit: true, notification: true } })).toBe(
      "custom",
    );
  });

  it("labels a missing role Co-manager", () => {
    expect(teamRoleListLabel(null)).toBe("Co-manager");
    expect(teamRoleListLabel("leasing")).toBe("Leasing");
  });
});

describe("role name is not authorization", () => {
  it("denies when the map is empty even if the stored role says full", () => {
    const perms = normalizePropertyCoManagerPermissions({ [HOUSE]: {} }, [HOUSE]);
    expect(coManagerModuleAllowed(perms, HOUSE, "payments", "delete")).toBe(false);
    expect(coManagerModuleAllowed(perms, HOUSE, "bankAccount")).toBe(false);
  });
});
