import { describe, expect, it } from "vitest";
import {
  NATIVE_BOTTOM_NAV_ADMIN_PRIMARY,
  NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER,
  NATIVE_BOTTOM_NAV_PRO_MANAGER_PRIMARY,
  NATIVE_BOTTOM_NAV_RESIDENT_ORDER,
  NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY,
  NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY,
  NATIVE_BOTTOM_NAV_RESIDENT_PRIMARY,
  NATIVE_BOTTOM_NAV_VENDOR_PRIMARY,
  nativeBottomBarEnabledForKind,
  nativeBottomNavShowMoreTab,
  orderNativeBottomNavItems,
  pickNativeBottomNavItems,
  splitNativeBottomNavItems,
} from "@/lib/native/portal-bottom-nav";
import { adminPortal } from "@/lib/portals/admin";
import { proPortal } from "@/lib/portals/pro";
import {
  RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS,
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
  RESIDENT_UNIFIED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

function sectionIds(sections: { section: string }[]): string[] {
  return sections.map((s) => s.section);
}

describe("orderNativeBottomNavItems", () => {
  it("preserves pro registry order with feedback after co-managers", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "pro").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(proPortal.sections));
    expect(ordered.indexOf("teams")).toBeLessThan(ordered.indexOf("bugs-feedback"));
    expect(ordered.at(-1)).toBe("profile");
  });

  it("matches exported pro manager tab order through feedback", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "pro").map((item) => item.section);
    expect(ordered.slice(0, NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER.length)).toEqual([
      ...NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER,
    ]);
  });

  it("pins Settings to the end when it is not already last", () => {
    const items = [
      { section: "profile", label: "Settings" },
      { section: "dashboard", label: "Dashboard" },
      { section: "leases", label: "Leases" },
    ];
    expect(pickNativeBottomNavItems(items, "pro").map((item) => item.section)).toEqual([
      "dashboard",
      "leases",
      "profile",
    ]);
  });

  it("preserves resident unified catalog order for the More sheet", () => {
    const items = RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "resident").map((item) => item.section);
    expect(ordered.filter((id) => id !== "profile")).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_ORDER]);
    expect(ordered.at(-1)).toBe("profile");
  });

  it("preserves resident limited registry order (known sections follow unified order)", () => {
    const items = RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "resident").map((item) => item.section);
    const expected = orderNativeBottomNavItems(
      RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label })),
      "resident",
    ).map((item) => item.section);
    expect(ordered).toEqual(expected);
    expect(ordered.at(-1)).toBe("profile");
  });

  it("preserves admin registry order", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "admin").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(adminPortal.sections));
    expect(ordered.at(-1)).toBe("profile");
  });
});

describe("splitNativeBottomNavItems", () => {
  it("curates the pro manager bar to the primary set and overflows the rest", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const { primary, overflow } = splitNativeBottomNavItems(items, "pro");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_PRO_MANAGER_PRIMARY]);
    expect(overflow.map((item) => item.section)).toContain("applications");
    expect(overflow.map((item) => item.section)).toContain("leases");
    expect(overflow.map((item) => item.section)).toContain("documents");
    expect(overflow.map((item) => item.section)).not.toContain("bugs-feedback");
    expect(primary.length + overflow.length).toBe(items.length - 2);
  });

  // Submitting is not approval: the bar must not promote Lease/Payments here, or
  // its first two tabs are locked and the phone nav goes half-dead.
  it("curates the resident bar (application submitted) to the pre-approval primary set", () => {
    const items = RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const { primary } = splitNativeBottomNavItems(items, "resident", "application_submitted");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY]);
  });

  it("curates the resident bar (post-approval) to the post-approval primary set", () => {
    const items = RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const { primary, overflow } = splitNativeBottomNavItems(items, "resident", "post_approval_pre_lease");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY]);
    expect(overflow.map((item) => item.section)).toContain("dashboard");
    expect(overflow.map((item) => item.section)).not.toContain("tour");
    expect(overflow.map((item) => item.section)).toContain("documents");
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  it("curates the resident bar (pre-approval) to the pre-approval primary set", () => {
    const items = RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const { primary } = splitNativeBottomNavItems(items, "resident", "pre_approval");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY]);
  });

  it("curates the resident bar (post-lease) to the primary set and overflows the rest", () => {
    const items = RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const { primary, overflow } = splitNativeBottomNavItems(items, "resident", "post_lease");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_PRIMARY]);
    expect(overflow.map((item) => item.section)).toContain("documents");
    expect(overflow.map((item) => item.section)).toContain("dashboard");
    expect(overflow.map((item) => item.section)).not.toContain("tour");
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  it("curates the admin bar to the primary set and overflows the rest", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const { primary, overflow } = splitNativeBottomNavItems(items, "admin");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_ADMIN_PRIMARY]);
    expect(overflow.map((item) => item.section)).not.toContain("profile");
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  it("fails closed (not open) for an unrecognized kind — nothing goes on the fixed bar", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    // @ts-expect-error deliberately probing an unknown/future role
    const { primary, overflow } = splitNativeBottomNavItems(items, "future-role");
    expect(primary).toEqual([]);
    expect(overflow.length).toBe(items.length);
  });

  it("fails closed for a missing kind too", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const { primary, overflow } = splitNativeBottomNavItems(items, undefined);
    expect(primary).toEqual([]);
    expect(overflow.length).toBe(items.length);
  });
});

describe("nativeBottomBarEnabledForKind", () => {
  it("is enabled for every role, including resident", () => {
    expect(nativeBottomBarEnabledForKind("pro")).toBe(true);
    expect(nativeBottomBarEnabledForKind("manager")).toBe(true);
    expect(nativeBottomBarEnabledForKind("admin")).toBe(true);
    expect(nativeBottomBarEnabledForKind("vendor")).toBe(true);
    expect(nativeBottomBarEnabledForKind("resident")).toBe(true);
    expect(nativeBottomBarEnabledForKind(undefined)).toBe(true);
  });
});

describe("nativeBottomNavShowMoreTab", () => {
  it("shows the More tab for pro/manager, resident, and vendor when primary sets don't cover every section", () => {
    expect(nativeBottomNavShowMoreTab("pro")).toBe(true);
    expect(nativeBottomNavShowMoreTab("manager")).toBe(true);
    expect(nativeBottomNavShowMoreTab("resident")).toBe(true);
    expect(nativeBottomNavShowMoreTab("vendor")).toBe(true);
  });

  it("skips the More tab for admin", () => {
    expect(nativeBottomNavShowMoreTab("admin")).toBe(false);
    expect(nativeBottomNavShowMoreTab(undefined)).toBe(false);
  });

  it("vendor primary tabs plus back arrow (dashboard) and profile menu (settings) cover 6 of 7 vendor sections", () => {
    const coveredByBackAndProfile = new Set(["dashboard", "profile"]);
    const coveredSections = new Set([...NATIVE_BOTTOM_NAV_VENDOR_PRIMARY, ...coveredByBackAndProfile]);
    expect(coveredSections.size).toBe(6);
  });
});
