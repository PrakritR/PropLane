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
  it("pro native order matches web registry through feedback after co-managers", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const ordered = orderNativeBottomNavItems(items, "pro").map((item) => item.section);
    expect(ordered).toEqual(sectionIds(proPortal.sections));
    expect(ordered.indexOf("relationships")).toBeLessThan(ordered.indexOf("bugs-feedback"));
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
      "documents",
      "profile",
    ]);
    expect(ordered.at(-1)).toBe("profile");
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
      "move-in",
      "documents",
      "profile",
    ]);
  });
});

describe("pro portal nav grouping (leasing → tenancy → operations → marketing → team → finances → account)", () => {
  const sections = sectionIds(proPortal.sections);
  const leasingBlock = ["properties", "tours", "applications", "leases"];
  const tenancyBlock = ["residents", "payments", "services"];
  const operationsBlock = ["calendar", "task-list", "communication"];
  const financesBlock = ["financials", "documents"];

  it("places leasing workflow contiguously after dashboard", () => {
    expectContiguousBlock(sections, leasingBlock, "dashboard", "residents");
  });

  it("groups tenancy after leasing", () => {
    expectContiguousBlock(sections, tenancyBlock, "leases", "calendar");
  });

  it("groups operations before marketing", () => {
    expectContiguousBlock(sections, operationsBlock, "services", "relationships");
  });

  it("groups finances after team sections", () => {
    expectContiguousBlock(sections, financesBlock, "promotion", "bugs-feedback");
  });

  it("places feedback after finances and before settings", () => {
    expect(sections.slice(-4)).toEqual(["documents", "bugs-feedback", "app", "profile"]);
  });

  it("does not expose plan as a top-level nav section", () => {
    expect(sections).not.toContain("plan");
  });

  it("free operational sections precede the finances block", () => {
    expect(sections.slice(0, 13)).toEqual([
      "dashboard",
      "properties",
      "tours",
      "applications",
      "leases",
      "residents",
      "payments",
      "services",
      "calendar",
      "task-list",
      "communication",
      "relationships",
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
    expectContiguousBlock(sections, ["applications", "lease", "move-in"], "communication", "documents");
  });

  it("approved: keeps documents next to settings after the post-lease workspace", () => {
    const sections = sectionIds(RESIDENT_APPROVED_PORTAL_SECTIONS);
    expect(sections.slice(-2)).toEqual(["documents", "profile"]);
    expect(sections.indexOf("move-in")).toBeLessThan(sections.indexOf("documents"));
  });
});

describe("pro portal documents section", () => {
  it("includes documents and finances nav sections", () => {
    const sections = sectionIds(proPortal.sections);
    expect(sections).toContain("documents");
    expect(sections).toContain("financials");
  });

  it("documents tabs include library, templates, applications, leases, income/expense docs, occupancy, 1099, and tax summary", () => {
    const documents = proPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs.map((t) => t.id)).toEqual([
      "library",
      "templates",
      "applications",
      "leases",
      "income-documents",
      "expense-documents",
      "occupancy",
      "1099",
      "tax-summary",
    ]);
  });

  it("finances tabs are income and expenses", () => {
    const financials = proPortal.sections.find((s) => s.section === "financials");
    expect(financials?.label).toBe("Finances");
    expect(financials?.tabs.map((t) => t.id)).toEqual([
      "income",
      "expenses",
      "trial-balance",
      "balance-sheet",
      "general-ledger",
      "cash-flow-statement",
      "payout-history",
      "trust-account-balance",
      "security-deposits",
      "financial-diagnostics",
      "ap-aging",
      "bills",
      "budget-vs-actual",
      "bank-reconciliation",
      "owner-statement",
      "owner-distributions",
    ]);
  });

  it("services tabs are requests, work orders, and vendors", () => {
    const services = proPortal.sections.find((s) => s.section === "services");
    expect(services?.tabs.map((t) => t.id)).toEqual(["requests", "work-orders", "vendors"]);
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
