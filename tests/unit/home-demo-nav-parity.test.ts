/**
 * The home demo's sidebar must be the real portal's sidebar (captain 2026-10-07: "the home dashboard must be
 * IDENTICAL to the real dashboard — same sidebar tabs"). The expectation is rebuilt here straight from the
 * real nav config (`PORTAL_NAV_GROUPS` over each portal's registered sections), not from the demo's own helper,
 * so a section added, renamed, moved or re-grouped in the product fails this test until the demo follows, and
 * every sidebar row, and every section folded into a row (a tab of the real strip), has a panel behind it.
 */
import { describe, expect, it } from "vitest";
import { DEMO_TABS, type DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { demoPanelIds } from "@/components/marketing/site/product-mock/demo-panels";
import { collapseNavItems, groupNavItems, SIDEBAR_EXCLUDED_SECTIONS } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS, withoutConditionalResidentSections } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import type { PortalKind, PortalSection } from "@/lib/portal-types";

const REAL: Record<DemoPortal, { kind: PortalKind; sections: PortalSection[] }> = {
  manager: { kind: "pro", sections: proPortal.sections },
  // Stays is drawn only for an account that has a stay row; the demo's fixture resident has none, so the
  // real sidebar it mirrors does not list it either.
  resident: { kind: "resident", sections: withoutConditionalResidentSections(RESIDENT_UNIFIED_PORTAL_SECTIONS) },
  vendor: { kind: "vendor", sections: vendorPortal.sections },
};

/**
 * What the real desktop sidebar draws for a portal: the registered sections folded into rows
 * (`collapseNavItems`, the same fold the sidebar uses) and bucketed by the real groups, in order, with the
 * real labels. `members` is each row's folded sections (the tabs of the real strip).
 */
function expectedRows(portal: DemoPortal) {
  const { kind, sections } = REAL[portal];
  const items = collapseNavItems(
    kind,
    sections.map((section) => ({ section: section.section, label: section.label })),
  );
  return groupNavItems(kind, items).flatMap((group) =>
    group.items.map((item) => ({
      id: item.section,
      label: item.label,
      group: group.label ?? undefined,
      members: item.groupSections ?? [item.section],
    })),
  );
}

describe.each(["manager", "resident", "vendor"] as DemoPortal[])("demo sidebar follows the real %s nav", (portal) => {
  it("has the same rows, labels, order and group headings", () => {
    const rows = DEMO_TABS[portal].map((tab) => ({ id: tab.id, label: tab.label, group: tab.group, members: tab.members }));
    expect(rows).toEqual(expectedRows(portal));
  });

  it("is a handful of rows, each folded section in exactly one row", () => {
    const rows = DEMO_TABS[portal];
    expect(rows.length).toBeLessThanOrEqual(6);
    const reach = rows.flatMap((row) => row.members);
    expect(new Set(reach).size).toBe(reach.length);
  });

  it("never lists a section the real sidebar leaves out (Settings, Feedback, App, Teams)", () => {
    for (const tab of DEMO_TABS[portal]) expect(SIDEBAR_EXCLUDED_SECTIONS.has(tab.id)).toBe(false);
  });

  it("opens a panel for every sidebar row and every section folded into one, and for nothing else", () => {
    const panels = new Set(demoPanelIds(portal));
    const rows = DEMO_TABS[portal];
    for (const row of rows) {
      expect(panels.has(row.id), `${portal} row ${row.id} has no panel`).toBe(true);
      for (const member of row.members) expect(panels.has(member), `${portal} tab ${member} has no panel`).toBe(true);
    }
    // No panel for a section the real sidebar lacks: every panel is a row or a folded member of one.
    const reachable = new Set(rows.flatMap((row) => [row.id, ...row.members]));
    expect([...panels].filter((id) => !reachable.has(id))).toEqual([]);
  });
});

describe("the one nested row", () => {
  it("draws the vendor's Finances as a tab of the Money row with no sub-rows, like the real nav", () => {
    const finances = DEMO_TABS.vendor.find((tab) => tab.members.includes("financials"))!;
    expect(finances.id).toBe("payments");
    const real = vendorPortal.sections.find((section) => section.section === "financials")!;
    expect(real.tabs).toEqual([]);
    expect(finances.subItems ?? []).toEqual([]);
  });

  it("nests nothing else", () => {
    const nested = (Object.keys(DEMO_TABS) as DemoPortal[]).flatMap((portal) =>
      DEMO_TABS[portal].filter((tab) => tab.subItems?.length).map((tab) => `${portal}:${tab.id}`),
    );
    expect(nested).toEqual([]);
  });
});
