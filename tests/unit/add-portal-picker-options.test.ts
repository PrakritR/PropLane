import { describe, expect, it } from "vitest";
import {
  AUTH_PORTAL_PICKER_OPTIONS,
  filterAddablePortalPickerOptions,
} from "@/lib/auth/auth-portal-picker-options";
import { getStartedAddPortalPath, isGetStartedAddMode } from "@/lib/auth/get-started-path";

describe("add portal picker", () => {
  it("builds the add-portal get-started path", () => {
    expect(getStartedAddPortalPath()).toBe("/auth/get-started?mode=add");
  });

  it("detects add mode from search params", () => {
    expect(isGetStartedAddMode("mode=add")).toBe(true);
    expect(isGetStartedAddMode(new URLSearchParams("mode=add"))).toBe(true);
    expect(isGetStartedAddMode(new URLSearchParams(""))).toBe(false);
  });

  it("returns all picker options when the user has no portal roles yet", () => {
    const filtered = filterAddablePortalPickerOptions([]);
    expect(filtered.map((opt) => opt.id)).toEqual(AUTH_PORTAL_PICKER_OPTIONS.map((opt) => opt.id));
  });

  it("excludes roles the user already has", () => {
    const filtered = filterAddablePortalPickerOptions(["admin", "manager"]);
    expect(filtered.map((opt) => opt.id)).toEqual(["resident", "vendor"]);
  });

  it("returns none when every picker role is already owned", () => {
    const filtered = filterAddablePortalPickerOptions(["manager", "resident", "vendor"]);
    expect(filtered).toEqual([]);
  });

  it("never offers the manager card to an account already holding manager and admin", () => {
    // Roles here mirror what /api/auth/portal-roles returns for an admin who
    // also holds the manager role (see founder-property-portal-block.test.ts):
    // reachablePortalRoles includes "manager" for them, so this account must
    // not be offered the manager card again.
    const filtered = filterAddablePortalPickerOptions(["admin", "manager"]);
    expect(filtered.some((opt) => opt.id === "manager")).toBe(false);
    expect(filtered.map((opt) => opt.id)).toEqual(["resident", "vendor"]);
  });
});
