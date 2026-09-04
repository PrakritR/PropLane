import { describe, expect, it } from "vitest";

import {
  buildAllModulesGrant,
  coManagerModuleAllowed,
  coManagerPermissionsAreEmpty,
  describeCoManagerPermissions,
  normalizeCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

const PROPERTY = "prop-1";

/**
 * The empty co-manager grant used to mean "no restrictions" — every module at
 * every level. These lock the inversion in: an empty map confers nothing, and
 * the two gestures that produced one (checking a property, and turning every
 * level off) can no longer hand a third party delete rights on leases,
 * financials and documents.
 */
describe("empty co-manager permissions confer no access", () => {
  it("denies every module when the per-property map is empty", () => {
    const perms: PropertyCoManagerPermissions = { [PROPERTY]: {} };
    for (const moduleId of ["leases", "financials", "documents", "payments", "properties"] as const) {
      expect(coManagerModuleAllowed(perms, PROPERTY, moduleId)).toBe(false);
      expect(coManagerModuleAllowed(perms, PROPERTY, moduleId, "edit")).toBe(false);
      expect(coManagerModuleAllowed(perms, PROPERTY, moduleId, "delete")).toBe(false);
    }
  });

  it("denies when the property has no entry at all", () => {
    expect(coManagerModuleAllowed({}, PROPERTY, "leases")).toBe(false);
    expect(coManagerModuleAllowed(undefined, PROPERTY, "leases")).toBe(false);
  });

  it("denies when the whole permissions body was omitted by the caller", () => {
    // `POST /api/pro/account-links` normalizes a body with no permissions key.
    const perms = normalizePropertyCoManagerPermissions(undefined, [PROPERTY]);
    expect(coManagerModuleAllowed(perms, PROPERTY, "documents")).toBe(false);
    expect(coManagerModuleAllowed(perms, PROPERTY, "documents", "delete")).toBe(false);
  });

  it("treats unchecking every module as least privilege, not full access", () => {
    // The editor drops a module key once all three levels are off.
    const afterUncheckingEverything = normalizeCoManagerPermissions({
      leases: { read: false, edit: false, delete: false },
      financials: { read: false, edit: false, delete: false },
    });
    expect(coManagerPermissionsAreEmpty(afterUncheckingEverything)).toBe(true);
    expect(coManagerModuleAllowed({ [PROPERTY]: afterUncheckingEverything }, PROPERTY, "leases")).toBe(false);
  });

  it("still allows exactly what was enumerated, at the level granted", () => {
    const perms: PropertyCoManagerPermissions = {
      [PROPERTY]: normalizeCoManagerPermissions({ leases: { read: true }, payments: { read: true, edit: true } }),
    };
    expect(coManagerModuleAllowed(perms, PROPERTY, "leases")).toBe(true);
    expect(coManagerModuleAllowed(perms, PROPERTY, "leases", "edit")).toBe(false);
    expect(coManagerModuleAllowed(perms, PROPERTY, "payments", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, PROPERTY, "payments", "delete")).toBe(false);
    expect(coManagerModuleAllowed(perms, PROPERTY, "documents")).toBe(false);
  });

  it("grants everything only when it is stated explicitly", () => {
    const perms: PropertyCoManagerPermissions = { [PROPERTY]: buildAllModulesGrant("full") };
    expect(coManagerModuleAllowed(perms, PROPERTY, "financials", "delete")).toBe(true);
    expect(coManagerPermissionsAreEmpty(perms[PROPERTY])).toBe(false);
  });

  it("seeds a checked property with a real grant, never the empty sentinel", () => {
    // Mirrors the invite panel's toggleProp seed.
    const seeded = buildAllModulesGrant("read");
    expect(coManagerPermissionsAreEmpty(seeded)).toBe(false);
    expect(coManagerModuleAllowed({ [PROPERTY]: seeded }, PROPERTY, "leases")).toBe(true);
    expect(coManagerModuleAllowed({ [PROPERTY]: seeded }, PROPERTY, "leases", "edit")).toBe(false);
    expect(coManagerModuleAllowed({ [PROPERTY]: seeded }, PROPERTY, "leases", "delete")).toBe(false);
  });
});

describe("describeCoManagerPermissions", () => {
  it("says so plainly when nothing is granted", () => {
    expect(describeCoManagerPermissions({})).toBe("No access to any module.");
  });

  it("separates view, edit and delete so the invite states the real grant", () => {
    const text = describeCoManagerPermissions(
      normalizeCoManagerPermissions({ leases: { read: true }, financials: { read: true, delete: true } }),
    );
    expect(text).toContain("view Leases");
    expect(text).toContain("delete in Finances");
  });
});
