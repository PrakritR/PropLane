import { describe, expect, it } from "vitest";
import {
  buildAllModulesGrant,
  CO_MANAGER_PERMISSION_OPTIONS,
  coManagerPortalSectionAllowed,
  flatCoManagerPermissionsFromProperty,
  hasCoManagerPermission,
  hasCoManagerPermissionLevel,
  mergeCoManagerPermissionsFromPropertyRows,
  normalizeCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  permissionsForProperty,
} from "@/lib/co-manager-permissions";
import { deriveManagerNavRole } from "@/lib/co-manager-nav";

describe("buildAllModulesGrant (editor presets)", () => {
  const allIds = CO_MANAGER_PERMISSION_OPTIONS.map((o) => o.id);

  it("stamps every module for each preset", () => {
    for (const preset of ["read", "edit", "delete", "full"] as const) {
      const grant = buildAllModulesGrant(preset);
      expect(Object.keys(grant).sort()).toEqual([...allIds].sort());
    }
  });

  it("read grants read + notify, not edit/delete", () => {
    const g = buildAllModulesGrant("read");
    expect(hasCoManagerPermissionLevel(g, "payments", "read")).toBe(true);
    expect(hasCoManagerPermissionLevel(g, "payments", "notification")).toBe(true);
    expect(hasCoManagerPermissionLevel(g, "payments", "edit")).toBe(false);
    expect(hasCoManagerPermissionLevel(g, "payments", "delete")).toBe(false);
  });

  it("edit grants read+edit+notify but not delete; delete grants read+delete+notify but not edit", () => {
    const edit = buildAllModulesGrant("edit");
    expect(hasCoManagerPermissionLevel(edit, "documents", "edit")).toBe(true);
    expect(hasCoManagerPermissionLevel(edit, "documents", "notification")).toBe(true);
    expect(hasCoManagerPermissionLevel(edit, "documents", "delete")).toBe(false);
    const del = buildAllModulesGrant("delete");
    expect(hasCoManagerPermissionLevel(del, "documents", "delete")).toBe(true);
    expect(hasCoManagerPermissionLevel(del, "documents", "notification")).toBe(true);
    expect(hasCoManagerPermissionLevel(del, "documents", "edit")).toBe(false);
  });

  it("full grants all four levels (collapses to legacy true)", () => {
    const g = buildAllModulesGrant("full");
    expect(g.calendar).toBe(true);
    for (const level of ["read", "edit", "delete", "notification"] as const) {
      expect(hasCoManagerPermissionLevel(g, "calendar", level)).toBe(true);
    }
  });

  it("notification can be granted without read access", () => {
    const g = normalizeCoManagerPermissions({ payments: { notification: true } });
    expect(hasCoManagerPermissionLevel(g, "payments", "notification")).toBe(true);
    expect(hasCoManagerPermissionLevel(g, "payments", "read")).toBe(false);
  });

  it("read implies notification unless notification is explicitly false", () => {
    const implied = normalizeCoManagerPermissions({ payments: { read: true } });
    expect(hasCoManagerPermissionLevel(implied, "payments", "notification")).toBe(true);
    const optedOut = normalizeCoManagerPermissions({ payments: { read: true, notification: false } });
    expect(hasCoManagerPermissionLevel(optedOut, "payments", "notification")).toBe(false);
    expect(hasCoManagerPermissionLevel(optedOut, "payments", "read")).toBe(true);
  });
});

describe("normalizePropertyCoManagerPermissions", () => {
  it("expands legacy flat permissions to each assigned property", () => {
    const result = normalizePropertyCoManagerPermissions(
      { applications: true, payments: true },
      ["prop-a", "prop-b"],
    );
    expect(result).toEqual({
      "prop-a": { applications: true, payments: true },
      "prop-b": { applications: true, payments: true },
    });
  });

  it("keeps per-property maps", () => {
    const result = normalizePropertyCoManagerPermissions(
      {
        "prop-a": { applications: true },
        "prop-b": { payments: true },
      },
      ["prop-a", "prop-b"],
    );
    expect(permissionsForProperty(result, "prop-a")).toEqual({ applications: true });
    expect(permissionsForProperty(result, "prop-b")).toEqual({ payments: true });
  });
});

describe("mergeCoManagerPermissionsFromPropertyRows", () => {
  it("merges permissions across properties on multiple links", () => {
    const merged = mergeCoManagerPermissionsFromPropertyRows([
      {
        propertyCoManagerPermissions: {
          "prop-a": { applications: true },
          "prop-b": { inbox: true },
        },
      },
      {
        propertyCoManagerPermissions: {
          "prop-c": { payments: true },
        },
      },
    ]);
    expect(merged).toEqual({ applications: true, inbox: true, payments: true });
  });

  it("falls back to flat coManagerPermissions", () => {
    const merged = mergeCoManagerPermissionsFromPropertyRows([
      { coManagerPermissions: { leases: true } },
    ]);
    expect(merged).toEqual({ leases: true });
  });
});

describe("flatCoManagerPermissionsFromProperty", () => {
  it("unions permissions across properties", () => {
    const flat = flatCoManagerPermissionsFromProperty({
      "prop-a": { applications: true },
      "prop-b": { payments: true, applications: true },
    });
    expect(flat).toEqual({ applications: true, payments: true });
  });
});

describe("coManagerPortalSectionAllowed", () => {
  it("allows promotion when granted", () => {
    expect(
      coManagerPortalSectionAllowed({
        section: "promotion",
        isPrimaryManager: false,
        mergedPermissions: { promotion: true },
      }),
    ).toBe(true);
  });

  it("keeps module tabs navigable for co-managers regardless of merged permissions", () => {
    for (const section of ["payments", "tours", "tasks", "bookings", "vendors"]) {
      expect(
        coManagerPortalSectionAllowed({
          section,
          isPrimaryManager: false,
          mergedPermissions: { promotion: true },
        }),
      ).toBe(true);
    }
  });

  it("shows module sections for an empty-permission co-manager link", () => {
    for (const section of ["payments", "residents", "financials", "services"]) {
      expect(
        coManagerPortalSectionAllowed({
          section,
          isPrimaryManager: false,
          mergedPermissions: {},
          hasEmptyPermissionCoManagerLink: true,
        }),
      ).toBe(true);
    }
  });

  it("always shows the Teams section, even for a pure co-manager", () => {
    expect(
      coManagerPortalSectionAllowed({
        section: "teams",
        isPrimaryManager: false,
        mergedPermissions: {},
      }),
    ).toBe(true);
    expect(
      coManagerPortalSectionAllowed({
        section: "relationships",
        isPrimaryManager: false,
        mergedPermissions: {},
      }),
    ).toBe(true);
    expect(
      coManagerPortalSectionAllowed({
        section: "relationships",
        isPrimaryManager: false,
        mergedPermissions: { payments: true },
      }),
    ).toBe(true);
  });

  it("does not unlock unknown sections for an empty-permission co-manager link", () => {
    expect(
      coManagerPortalSectionAllowed({
        section: "some-unknown-section",
        isPrimaryManager: false,
        mergedPermissions: {},
        hasEmptyPermissionCoManagerLink: true,
      }),
    ).toBe(false);
  });

  it("allows mapped module sections even when merged permissions are empty", () => {
    expect(
      coManagerPortalSectionAllowed({
        section: "payments",
        isPrimaryManager: false,
        mergedPermissions: {},
      }),
    ).toBe(true);
  });
});

describe("hasCoManagerPermission", () => {
  it("treats properties permission as listing edit access", () => {
    expect(hasCoManagerPermission({ properties: true }, "editListings")).toBe(true);
  });

  it("maps legacy editListings reads to properties on normalize", () => {
    expect(normalizeCoManagerPermissions({ editListings: true })).toEqual({
      editListings: true,
      properties: true,
    });
  });
});

describe("deriveManagerNavRole with per-property permissions", () => {
  it("merges incoming per-property permissions for co-managers", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: {},
        propertyCoManagerPermissions: {
          "prop-a": { applications: true },
          "prop-b": { inbox: true },
        },
      },
    ]);
    expect(role.isPrimaryManager).toBe(false);
    expect(role.mergedPermissions).toEqual({ applications: true, inbox: true });
  });
});
