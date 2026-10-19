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
import { collapseNavItems, navRowSections } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import type { PortalKind } from "@/lib/portal-types";
import {
  RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS,
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
  RESIDENT_UNIFIED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

function sectionIds(sections: { section: string }[]): string[] {
  return sections.map((s) => s.section);
}

/** The shape the sidebar hands the bar: sections folded into their rows (`collapseNavItems`, portal-sidebar.tsx). */
function folded(kind: PortalKind, sections: { section: string; label: string }[]) {
  return collapseNavItems(
    kind,
    sections.map((s) => ({ section: s.section, label: s.label })),
  );
}

describe("orderNativeBottomNavItems", () => {
  it("preserves pro registry order with settings last (no Teams page)", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "pro").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(proPortal.sections));
    expect(ordered).not.toContain("teams");
    expect(ordered.at(-1)).toBe("profile");
  });

  it("exported pro manager tab order covers the registry and follows the sidebar's row order", () => {
    const order = NATIVE_BOTTOM_NAV_PRO_MANAGER_ORDER as readonly string[];
    // Every registry section except Settings (pinned last in the bar) is in the exported order, once.
    const registry = sectionIds(proPortal.sections).filter((id) => id !== "profile");
    expect([...order].sort()).toEqual([...registry].sort());
    expect(order.length).toBe(new Set(order).size);
    // The six rows come in sidebar order (Home, Communication, Properties, Leasing, People, Money) ...
    const rowKeys = navRowSections("pro");
    expect(order.filter((id) => rowKeys.includes(id))).toEqual(rowKeys);
    // ... and the unfolded tail (Move-in, Feedback, App) follows them.
    expect(order.slice(-3)).toEqual(["move-in", "bugs-feedback", "app"]);
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
    expect(ordered).toEqual([...NATIVE_BOTTOM_NAV_RESIDENT_ORDER]);
  });

  it("preserves resident limited registry order (known sections follow unified order)", () => {
    const items = RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "resident").map((item) => item.section);
    const expected = orderNativeBottomNavItems(
      RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label })),
      "resident",
    ).map((item) => item.section);
    expect(ordered).toEqual(expected);
    expect(ordered.at(-1)).toBe("documents");
  });

  it("preserves admin registry order with Settings (the first sidebar row) pinned last in the bar", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "admin").map((item) => item.section);
    expect(ordered).toEqual([...sectionIds(adminPortal.sections).filter((id) => id !== "profile"), "profile"]);
    expect(ordered.at(-1)).toBe("profile");
  });
});

describe("splitNativeBottomNavItems", () => {
  it("curates the pro manager bar to the primary set and overflows the rest", () => {
    const items = folded("pro", proPortal.sections);
    const { primary, overflow } = splitNativeBottomNavItems(items, "pro");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_PRO_MANAGER_PRIMARY]);
    // Applications, Tours and Forms are tabs of the Leasing row (key `leases`); Documents is a tab of Money
    // (key `payments`): the row, not the tab, is what overflows into More.
    expect(overflow.map((item) => item.section)).toContain("leases");
    expect(overflow.map((item) => item.section)).toContain("payments");
    expect(overflow.find((item) => item.section === "payments")).toMatchObject({
      groupSections: expect.arrayContaining(["documents", "financials"]),
    });
    expect(overflow.map((item) => item.section)).toContain("profile");
    expect(overflow.map((item) => item.section)).not.toContain("bugs-feedback");
    // bugs-feedback stays out of More; Settings (profile) overflows into More.
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  // Submitting is not approval: the bar must not promote Lease/Payments here, or
  // its first two tabs are locked and the phone nav goes half-dead. Tour and Application are one row
  // (Applying, key `applications`) so they take one slot between them.
  it("curates the resident bar (application submitted) to the pre-approval primary set", () => {
    const items = folded("resident", RESIDENT_LIMITED_PORTAL_SECTIONS);
    const { primary } = splitNativeBottomNavItems(items, "resident", "application_submitted");
    expect(primary.map((item) => item.section)).toEqual(["applications", "dashboard", "communication"]);
    expect(primary[0]).toMatchObject({ groupSections: expect.arrayContaining(["tour", "applications"]) });
    // Every pre-approval primary (a SECTION) is reached through one of those row slots.
    const reached = new Set(primary.flatMap((item) => (item as { groupSections?: string[] }).groupSections ?? [item.section]));
    for (const section of NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY) expect(reached.has(section)).toBe(true);
  });

  it("curates the resident bar (post-approval) to the post-approval primary set", () => {
    const items = folded("resident", RESIDENT_LIMITED_PORTAL_SECTIONS);
    const { primary, overflow } = splitNativeBottomNavItems(items, "resident", "post_approval_pre_lease");
    // Lease takes the My home slot (key `move-in`); Payments takes Money (which also holds Documents).
    expect(primary.map((item) => item.section)).toEqual(["move-in", "payments", "dashboard", "communication"]);
    expect(primary[0]).toMatchObject({ groupSections: expect.arrayContaining(["lease"]) });
    expect(primary[1]).toMatchObject({ groupSections: expect.arrayContaining(["payments", "documents"]) });
    const reached = new Set(primary.flatMap((item) => (item as { groupSections?: string[] }).groupSections ?? [item.section]));
    for (const section of NATIVE_BOTTOM_NAV_RESIDENT_POST_APPROVAL_PRIMARY) expect(reached.has(section)).toBe(true);
    expect(overflow.map((item) => item.section)).toContain("applications");
    expect(overflow.map((item) => item.section)).not.toContain("dashboard");
    // Resident orderNativeBottomNavItems omits Settings from the catalog; avatar menu remains.
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  it("curates the resident bar (pre-approval) to the pre-approval primary set", () => {
    const items = folded("resident", RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS);
    const { primary } = splitNativeBottomNavItems(items, "resident", "pre_approval");
    expect(primary.map((item) => item.section)).toEqual(["applications", "dashboard", "communication"]);
    const reached = new Set(primary.flatMap((item) => (item as { groupSections?: string[] }).groupSections ?? [item.section]));
    for (const section of NATIVE_BOTTOM_NAV_RESIDENT_PRE_APPROVAL_PRIMARY) expect(reached.has(section)).toBe(true);
  });

  it("curates the resident bar (post-lease) to the primary set and overflows the rest", () => {
    const items = folded("resident", RESIDENT_APPROVED_PORTAL_SECTIONS);
    const { primary, overflow } = splitNativeBottomNavItems(items, "resident", "post_lease");
    // Services takes the My home slot (Lease, Forms, Inspections are its other tabs).
    expect(primary.map((item) => item.section)).toEqual(["move-in", "payments", "dashboard", "communication"]);
    expect(primary[0]).toMatchObject({ groupSections: expect.arrayContaining(["services"]) });
    const reached = new Set(primary.flatMap((item) => (item as { groupSections?: string[] }).groupSections ?? [item.section]));
    for (const section of NATIVE_BOTTOM_NAV_RESIDENT_PRIMARY) expect(reached.has(section)).toBe(true);
    // Documents rides in the Money row's slot; the Applying row (Tour, Application) is what overflows.
    expect(primary[1]).toMatchObject({ groupSections: expect.arrayContaining(["documents"]) });
    expect(overflow.map((item) => item.section)).toContain("applications");
    expect(overflow.map((item) => item.section)).not.toContain("dashboard");
    // Resident catalog still omits Settings from bar+More; avatar menu covers it.
    expect(primary.length + overflow.length).toBe(items.length - 1);
  });

  it("curates the admin bar to the primary set and overflows the rest", () => {
    const items = folded("admin", adminPortal.sections);
    const { primary, overflow } = splitNativeBottomNavItems(items, "admin");
    expect(primary.map((item) => item.section)).toEqual([...NATIVE_BOTTOM_NAV_ADMIN_PRIMARY]);
    expect(overflow.map((item) => item.section)).toContain("profile");
    expect(primary.length + overflow.length).toBe(items.length);
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

  it("vendor primary bar is Work · Home · Communication · Money, with settings in the profile menu", () => {
    // Primaries are ROWS: Work holds Services, Calendar and Reviews; Money holds Payments, Outgoing, Finances
    // and Documents. The bar plus the profile menu still reach four rows directly.
    expect([...NATIVE_BOTTOM_NAV_VENDOR_PRIMARY]).toEqual(["work-orders", "dashboard", "communication", "payments"]);
    const coveredSections = new Set([...NATIVE_BOTTOM_NAV_VENDOR_PRIMARY, "profile"]);
    expect(coveredSections.size).toBe(5);
  });
});
