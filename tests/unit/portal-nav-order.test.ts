import { describe, expect, it } from "vitest";
import { FREE_SUBSCRIPTION_SECTIONS, managerSectionAllowedForTier } from "@/lib/manager-access";
import { orderNativeBottomNavItems } from "@/lib/native/portal-bottom-nav";
import { adminPortal } from "@/lib/portals/admin";
import { proPortal } from "@/lib/portals/pro";
import {
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_FREE_TIER_SECTION_IDS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

function sectionIds(sections: { section: string }[]): string[] {
  return sections.map((s) => s.section);
}

function expectContiguousBlock(sections: string[], block: string[], anchorAfter: string, anchorBefore: string) {
  const afterIdx = sections.indexOf(anchorAfter);
  const beforeIdx = sections.indexOf(anchorBefore);
  expect(afterIdx).toBeGreaterThanOrEqual(0);
  expect(beforeIdx).toBeGreaterThan(afterIdx);
  const slice = sections.slice(afterIdx + 1, beforeIdx);
  expect(slice).toEqual(block);
}

describe("portal nav order contracts", () => {
  it("separates resident collections from outgoing operations on every shared nav", () => {
    const incoming = proPortal.sections.find((section) => section.section === "payments");
    const outgoing = proPortal.sections.find((section) => section.section === "outgoing");
    expect(incoming).toMatchObject({ label: "Incoming payments", tabs: [] });
    expect(outgoing).toMatchObject({ label: "Outgoing payments", tabs: [] });
    const ids = sectionIds(proPortal.sections);
    expect(ids.indexOf("outgoing")).toBe(ids.indexOf("vendors") + 1);
  });

  it("pro native order matches web registry with settings last", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "pro").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(proPortal.sections));
    expect(ordered).not.toContain("teams");
    expect(ordered.at(-1)).toBe("profile");
  });

  it("admin native order matches web registry with settings last", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "admin").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(adminPortal.sections));
    expect(ordered.at(-1)).toBe("profile");
  });

  it("resident limited native order follows the cross-stage mobile order", () => {
    const items = RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "resident").map((item) => item.section);
    expect(ordered).toEqual([
      "tour",
      "applications",
      "dashboard",
      "lease",
      "payments",
      "communication",
      "forms",
      "documents",
    ]);
    expect(ordered.at(-1)).toBe("documents");
  });

  it("resident approved native order follows the cross-stage mobile order", () => {
    const items = RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "resident").map((item) => item.section);
    expect(ordered).toEqual([
      "tour",
      "applications",
      "dashboard",
      "lease",
      "services",
      "payments",
      "communication",
      // Forms is its own section; Inspections is a tab of My home (C1-R5) — no row of its own.
      "forms",
      "move-in",
      "documents",
    ]);
  });
});

describe("pro portal nav grouping (leasing → tenancy → operations → marketing → finances → account)", () => {
  const sections = sectionIds(proPortal.sections);
  // Screening nests inside the application record's own rail now
  // (docs/agents/record-page.md) — no separate "background-checks" nav row.
  const leasingBlock = ["properties", "tours", "applications", "leases"];
  // Move-in stays registered (a single inspection report keeps its address) but has no sidebar row: Forms replaced it.
  const tenancyBlock = ["residents", "forms", "move-in", "payments", "services"];
  const operationsBlock = ["vendors", "outgoing", "tasks", "calendar", "bookings", "communication"];
  const financesBlock = ["financials", "documents"];

  it("places leasing workflow contiguously after dashboard", () => {
    expectContiguousBlock(sections, leasingBlock, "dashboard", "residents");
  });

  it("groups tenancy after leasing", () => {
    expectContiguousBlock(sections, tenancyBlock, "leases", "vendors");
  });

  it("groups operations before marketing", () => {
    expectContiguousBlock(sections, operationsBlock, "services", "promotion");
  });

  it("groups finances after marketing", () => {
    expectContiguousBlock(sections, financesBlock, "promotion", "bugs-feedback");
  });

  it("places feedback after finances and before settings", () => {
    expect(sections.slice(-4)).toEqual(["documents", "bugs-feedback", "app", "profile"]);
  });

  it("does not expose plan or teams as top-level nav sections", () => {
    expect(sections).not.toContain("plan");
    expect(sections).not.toContain("teams");
  });

  it("free operational sections precede the finances block", () => {
    // Inspections is a tab of Move-in, not a sidebar row of its own.
    expect(sections).not.toContain("inspections");
    expect(sections.slice(0, 17)).toEqual([
      "dashboard",
      "properties",
      "tours",
      "applications",
      "leases",
      "residents",
      "forms",
      "move-in",
      "payments",
      "services",
      "vendors",
      "outgoing",
      "tasks",
      "calendar",
      "bookings",
      "communication",
      "promotion",
    ]);
  });
});

describe("resident portal nav grouping", () => {
  const freeIds = new Set<string>(RESIDENT_FREE_TIER_SECTION_IDS);

  it("limited: keeps the pre-lease workflow ahead of communication", () => {
    const sections = sectionIds(RESIDENT_LIMITED_PORTAL_SECTIONS);
    expectContiguousBlock(sections, ["lease", "payments"], "applications", "communication");
    for (const id of ["communication", "documents"]) {
      expect(freeIds.has(id)).toBe(id === "communication");
    }
  });

  it("approved: leads with resident operations before reference sections", () => {
    const sections = sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS);
    expect(sections.slice(0, 4)).toEqual(["services", "payments", "dashboard", "tour"]);
    expectContiguousBlock(sections, ["applications", "lease", "forms", "move-in"], "communication", "documents");
  });

  it("approved: ends navigation with documents, then the trailing Settings entry", () => {
    const sections = sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS);
    // Settings (profile) is pinned last in the sidebar registry (above "Need
    // help?"); Documents is the last ORDINARY nav destination, immediately
    // before it — the native bottom bar / More sheet catalog then excludes
    // "profile" entirely (see orderNativeBottomNavItems's resident branch).
    expect(sections.at(-1)).toBe("profile");
    expect(sections.at(-2)).toBe("documents");
    expect(sections.indexOf("move-in")).toBeLessThan(sections.indexOf("documents"));
  });
});

describe("pro portal documents section", () => {
  it("includes documents and finances nav sections", () => {
    const sections = sectionIds(proPortal.sections);
    expect(sections).toContain("documents");
    expect(sections).toContain("financials");
  });

  it("documents tabs are applications, leases, and other", () => {
    const documents = proPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs.map((t) => t.id)).toEqual(["applications", "leases", "other"]);
  });

  it("finances tabs are overview, activity and reports in nav", () => {
    const financials = proPortal.sections.find((s) => s.section === "financials");
    expect(financials?.label).toBe("Finances");
    expect(financials?.tabs.map((t) => t.id)).toEqual(["overview", "reports"]);
  });

  it("services is one list, with vendors its own section right after it", () => {
    // Add-on services and work orders are presented as a single queue — a manager thinks of them
    // as one pile of work — and Vendors is the section beside it: the people the work goes to.
    const services = proPortal.sections.find((s) => s.section === "services");
    expect(services?.tabs.map((t) => t.id)).toEqual([]);

    const vendors = proPortal.sections.find((s) => s.section === "vendors");
    expect(vendors?.label).toBe("Vendors");
    expect(proPortal.sections.find((s) => s.section === "teams")).toBeUndefined();
  });

  it("locks documents and financials for free tier", () => {
    expect(managerSectionAllowedForTier("documents", "free")).toBe(false);
    expect(managerSectionAllowedForTier("financials", "free")).toBe(false);
    expect(managerSectionAllowedForTier("documents", "paid")).toBe(true);
    expect(managerSectionAllowedForTier("financials", "paid")).toBe(true);
  });

  it("marks paid-only sections tierLocked for free users", () => {
    const locked = proPortal.sections
      .filter((s) => !FREE_SUBSCRIPTION_SECTIONS.has(s.section))
      .map((s) => s.section);
    expect(locked).toContain("documents");
    expect(locked).toContain("financials");
    expect(locked).not.toContain("properties");
  });
});
