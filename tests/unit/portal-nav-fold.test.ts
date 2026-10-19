/**
 * Portal simplification (Oct 18): every portal's sidebar is a handful of rows, each row standing for several
 * sections (`NAV_FOLDS`). Nothing is dropped - a section is a row or a tab of exactly one row, every id keeps its
 * URL, and a lock belongs to a TAB (a row is locked only when all its tabs are).
 */
import { describe, expect, it } from "vitest";
import { buildPortalNavItems } from "@/components/portal/portal-nav-model";
import { splitNativeBottomNavItems } from "@/lib/native/portal-bottom-nav";
import {
  NAV_FOLDS,
  PORTAL_NAV_GROUPS,
  SIDEBAR_EXCLUDED_SECTIONS,
  collapseNavItems,
  groupNavItems,
  isSectionListPath,
  mergeGroupCounts,
  navRowSection,
  navRowSections,
  navSectionTabsFor,
} from "@/lib/portals/nav-groups";
import { portalNavLockKind, portalNavRowLockKind } from "@/lib/portals/nav-locks";
import { proPortal } from "@/lib/portals/pro";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import { RESIDENT_BOTTOM_NAV_PRIMARY, residentSectionUnlockedForStage, type ResidentPortalNavStage } from "@/lib/resident-portal-nav";
import type { PortalDefinition } from "@/lib/portal-types";

const residentPortal: PortalDefinition = {
  kind: "resident",
  basePath: "/resident",
  title: "Resident",
  accent: "blue",
  sections: RESIDENT_UNIFIED_PORTAL_SECTIONS,
};

function rowsFor(definition: PortalDefinition, stage?: ResidentPortalNavStage) {
  const items = buildPortalNavItems(definition, definition.sections, false, stage);
  return collapseNavItems(definition.kind, items);
}

/** The rows in the order the sidebar draws them (the group config, not the registry). */
function sidebarRows(definition: PortalDefinition, stage?: ResidentPortalNavStage) {
  return groupNavItems(definition.kind, rowsFor(definition, stage)).flatMap((g) => g.items);
}

/** The sections the sidebar leaves out on purpose (Settings, Feedback, App, Move-in for managers). */
const NOT_A_ROW = new Set([...SIDEBAR_EXCLUDED_SECTIONS, "move-in"]);

describe("manager rows", () => {
  const rows = rowsFor(proPortal);

  it("is six rows: Home, Communication, Properties, Leasing, People, Money", () => {
    expect(sidebarRows(proPortal).map((r) => r.label)).toEqual([
      "Home",
      "Communication",
      "Properties",
      "Leasing",
      "People",
      "Money",
    ]);
  });

  it("puts each section in exactly one row", () => {
    const reach = rows.flatMap((r) => r.groupSections ?? [r.section]);
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual(proPortal.sections.map((s) => s.section).sort());
  });

  it("keeps the tab order the captain gave", () => {
    const tabs = (label: string) => rows.find((r) => r.label === label)?.groupSections;
    expect(tabs("Home")).toEqual(["dashboard", "calendar", "tasks"]);
    expect(tabs("Properties")).toEqual(["properties", "bookings", "promotion"]);
    expect(tabs("Leasing")).toEqual(["tours", "applications", "leases", "forms"]);
    expect(tabs("People")).toEqual(["residents", "vendors", "services"]);
    expect(tabs("Money")).toEqual(["payments", "outgoing", "financials", "documents"]);
  });

  it("is idempotent", () => {
    expect(collapseNavItems("pro", rows)).toEqual(rows);
  });

  it("links a row to its first tab and every tab keeps its own URL", () => {
    const hrefs = new Map(buildPortalNavItems(proPortal, proPortal.sections, false, undefined).map((i) => [i.section, i.href]));
    expect(hrefs.get("tasks")).toBe("/portal/tasks/open");
    expect(hrefs.get("leases")).toBe("/portal/leases");
    expect(hrefs.get("payments")).toBe("/portal/payments");
    expect(rows.find((r) => r.label === "Home")?.href).toBe("/portal/dashboard");
  });

  it("opens a row on its first free tab so a Free plan never lands on a paywall while a free tab exists", () => {
    const free = (section: string) => portalNavLockKind({ kind: "manager", section, subscriptionTier: "free" }) !== "none";
    const folded = collapseNavItems("manager", buildPortalNavItems(proPortal, proPortal.sections, false, undefined), {
      isLocked: free,
    });
    expect(folded.find((r) => r.label === "Leasing")?.href).toBe("/portal/tours");
    expect(folded.find((r) => r.label === "Money")?.href).toBe("/portal/payments");
  });

  it("locks a TAB on its own and a ROW only when every tab is locked (Free plan)", () => {
    const params = { kind: "manager" as const, subscriptionTier: "free" as const };
    const tab = (section: string) => portalNavLockKind({ ...params, section });
    expect(tab("tours")).toBe("none");
    expect(tab("leases")).toBe("upsell");
    expect(portalNavRowLockKind({ ...params, section: "leases" }, NAV_FOLDS.manager.leasing!.sections)).toBe("none");
    expect(portalNavRowLockKind({ ...params, section: "residents" }, NAV_FOLDS.manager.people!.sections)).toBe("upsell");
    expect(portalNavRowLockKind({ ...params, section: "dashboard" }, NAV_FOLDS.manager.home!.sections)).toBe("none");
  });

  it("buckets BOTH the folded and the unfolded shape (command palette)", () => {
    const folded = groupNavItems("pro", rows).flatMap((g) => g.items.map((i) => i.section));
    expect(folded.slice(0, 6)).toEqual(["dashboard", "communication", "properties", "leases", "residents", "payments"]);
    const unfolded = groupNavItems(
      "pro",
      proPortal.sections.map((s) => ({ section: s.section, label: s.label })),
    ).flatMap((g) => g.items.map((i) => i.section));
    for (const s of proPortal.sections) {
      if (NOT_A_ROW.has(s.section)) continue;
      expect(unfolded).toContain(s.section);
    }
  });

  it("sums a row's counts onto its key and leaves the tabs' own", () => {
    const merged = mergeGroupCounts("pro", {
      tours: { count: 2, tone: "muted" },
      applications: { count: 3, tone: "alert" },
    });
    expect(merged.leases).toEqual({ count: 5, tone: "alert" });
    expect(merged.tours).toEqual({ count: 2, tone: "muted" });
  });

  it("puts a primary phone tab on its ROW and never doubles a row", () => {
    const { primary } = splitNativeBottomNavItems(rows, "manager");
    expect(primary.map((r) => r.label)).toEqual(["Properties", "People", "Home", "Communication"]);
  });
});

describe("resident rows", () => {
  const rows = rowsFor(residentPortal);

  it("is five rows: Home, Communication, My home, Applying, Money", () => {
    expect(sidebarRows(residentPortal).filter((r) => r.section !== "profile").map((r) => r.label)).toEqual([
      "Home",
      "Communication",
      "My home",
      "Applying",
      "Money",
    ]);
    expect(rows.find((r) => r.label === "My home")?.groupSections).toEqual(["move-in", "lease", "forms", "services"]);
    expect(rows.find((r) => r.label === "Applying")?.groupSections).toEqual(["tour", "applications"]);
    expect(rows.find((r) => r.label === "Money")?.groupSections).toEqual(["payments", "documents"]);
  });

  it("reaches every section once", () => {
    const reach = rows.flatMap((r) => r.groupSections ?? [r.section]);
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual(residentPortal.sections.map((s) => s.section).sort());
  });

  it.each(Object.keys(RESIDENT_BOTTOM_NAV_PRIMARY) as ResidentPortalNavStage[])(
    "%s: every phone tab is a row with at least one tab open at that stage",
    (stage) => {
      const folded = rowsFor(residentPortal, stage);
      const { primary } = splitNativeBottomNavItems(folded, "resident", stage);
      expect(primary.length).toBeGreaterThan(0);
      for (const row of primary) {
        const members = (row as { groupSections?: string[] }).groupSections ?? [row.section];
        expect(members.some((s) => residentSectionUnlockedForStage(s, stage))).toBe(true);
      }
    },
  );

  it("locks My home tab by tab: the row opens once the lease does", () => {
    const params = { kind: "resident" as const, subscriptionTier: undefined };
    const members = NAV_FOLDS.resident["my-home"]!.sections;
    const stage = "post_approval_pre_lease" as const;
    expect(portalNavLockKind({ ...params, section: "move-in", residentNavStage: stage })).toBe("inert");
    expect(portalNavLockKind({ ...params, section: "lease", residentNavStage: stage })).toBe("none");
    expect(portalNavRowLockKind({ ...params, section: "move-in", residentNavStage: stage }, members)).toBe("none");
    expect(portalNavRowLockKind({ ...params, section: "move-in", residentNavStage: "pre_approval" }, members)).toBe("inert");
  });
});

describe("vendor rows", () => {
  it("is four rows: Home, Work, Communication, Money", () => {
    const rows = rowsFor(vendorPortal);
    expect(sidebarRows(vendorPortal).filter((r) => r.section !== "profile").map((r) => r.label)).toEqual(["Home", "Work", "Communication", "Money"]);
    expect(rows.find((r) => r.label === "Work")?.groupSections).toEqual(["work-orders", "calendar", "reviews"]);
    expect(rows.find((r) => r.label === "Money")?.groupSections).toEqual(["payments", "outgoing", "financials", "documents"]);
  });

  it("keeps Money on the phone bar", () => {
    const { primary } = splitNativeBottomNavItems(rowsFor(vendorPortal), "vendor");
    expect(primary.map((r) => r.label)).toEqual(["Work", "Home", "Communication", "Money"]);
  });
});

describe("fold config", () => {
  it("never folds a section into two rows, in any portal", () => {
    for (const [kind, folds] of Object.entries(NAV_FOLDS)) {
      const all = Object.values(folds).flatMap((g) => g.sections);
      expect(new Set(all).size, kind).toBe(all.length);
    }
  });

  it("keys every row on one of its own sections", () => {
    for (const folds of Object.values(NAV_FOLDS)) {
      for (const group of Object.values(folds)) {
        expect(group.sections).toContain(group.key ?? group.sections[0]);
      }
    }
  });

  it("lists every row key once in the sidebar group config", () => {
    for (const kind of ["pro", "manager", "resident", "vendor", "admin"] as const) {
      const keys = navRowSections(kind);
      const groupSections = PORTAL_NAV_GROUPS[kind].flatMap((g) => g.sections);
      for (const key of keys) expect(groupSections.filter((s) => s === key)).toHaveLength(1);
    }
  });

  it("maps a tab to its row", () => {
    expect(navRowSection("manager", "calendar")).toBe("dashboard");
    expect(navRowSection("manager", "forms")).toBe("leases");
    expect(navRowSection("manager", "communication")).toBe("communication");
    expect(navRowSection("resident", "lease")).toBe("move-in");
    expect(navRowSection("vendor", "calendar")).toBe("work-orders");
  });

  it("draws a strip only for a row with two or more tabs actually available", () => {
    const all = proPortal.sections.map((s) => s.section);
    expect(navSectionTabsFor("manager", "leases", all)?.sections).toEqual(["tours", "applications", "leases", "forms"]);
    expect(navSectionTabsFor("manager", "communication", all)).toBeNull();
    expect(navSectionTabsFor("vendor", "dashboard", ["dashboard"])).toBeNull();
    expect(navSectionTabsFor("resident", "dashboard", ["dashboard"])).toBeNull();
    expect(navSectionTabsFor("resident", "dashboard", ["dashboard", "stays"])?.sections).toEqual(["dashboard", "stays"]);
  });
});

describe("where the strip draws", () => {
  it.each([
    [["leases"], true],
    [["leases", "signed"], true],
    [["tasks", "open"], true],
    [["payments", "incoming", "pending"], true],
    [["properties", "listed"], true],
    [["documents", "1099"], true],
    [["financials", "reports"], true],
    [["communication", "active"], true],
    [["vendors"], true],
  ])("%j is a list page", (rest, expected) => {
    expect(isSectionListPath(rest)).toBe(expected);
  });

  it.each([
    [["vendors", "9d1c-uuid"]],
    [["leases", "signed", "lease-123"]],
    [["residents", "current", "res-1", "lease"]],
    [["properties", "all", "prop-9", "preview"]],
    [["applications", "pending", "app-1"]],
    [["payments", "incoming", "pending", "pay-1"]],
    [[]],
  ])("%j is a record page: no strip", (rest) => {
    expect(isSectionListPath(rest)).toBe(false);
  });
});
