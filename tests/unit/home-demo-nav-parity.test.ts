/**
 * The home demo's sidebar must be the real portal's sidebar (captain 2026-10-07: "the home dashboard must be
 * IDENTICAL to the real dashboard — same sidebar tabs"). The expectation is rebuilt here straight from the
 * real nav config (`PORTAL_NAV_GROUPS` over each portal's registered sections), not from the demo's own helper,
 * so a section added, renamed, moved or re-grouped in the product fails this test until the demo follows, and
 * every sidebar row has a panel behind it.
 */
import { describe, expect, it } from "vitest";
import { DEMO_TABS, type DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { demoPanelIds } from "@/components/marketing/site/product-mock/demo-panels";
import { PORTAL_NAV_GROUPS, SIDEBAR_EXCLUDED_SECTIONS } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { vendorPortal } from "@/lib/portals/vendor";
import type { PortalKind, PortalSection } from "@/lib/portal-types";

const REAL: Record<DemoPortal, { kind: PortalKind; sections: PortalSection[] }> = {
  manager: { kind: "pro", sections: proPortal.sections },
  resident: { kind: "resident", sections: RESIDENT_UNIFIED_PORTAL_SECTIONS },
  vendor: { kind: "vendor", sections: vendorPortal.sections },
};

/** What the real desktop sidebar draws for a portal: the real groups, in order, with the real labels. */
function expectedRows(portal: DemoPortal) {
  const { kind, sections } = REAL[portal];
  return PORTAL_NAV_GROUPS[kind].flatMap((group) =>
    group.sections
      .map((id) => sections.find((section) => section.section === id))
      .filter((section): section is PortalSection => Boolean(section) && !SIDEBAR_EXCLUDED_SECTIONS.has(section!.section))
      .map((section) => ({ id: section.section, label: section.label, group: group.label ?? undefined })),
  );
}

describe.each(["manager", "resident", "vendor"] as DemoPortal[])("demo sidebar follows the real %s nav", (portal) => {
  it("has the same rows, labels, order and group headings", () => {
    const rows = DEMO_TABS[portal].map((tab) => ({ id: tab.id, label: tab.label, group: tab.group }));
    expect(rows).toEqual(expectedRows(portal));
  });

  it("never lists a section the real sidebar leaves out (Settings, Feedback, App, Teams)", () => {
    for (const tab of DEMO_TABS[portal]) expect(SIDEBAR_EXCLUDED_SECTIONS.has(tab.id)).toBe(false);
  });

  it("opens a panel for every sidebar row, and has no panel for a row the real sidebar lacks", () => {
    expect([...demoPanelIds(portal)].sort()).toEqual(DEMO_TABS[portal].map((tab) => tab.id).sort());
  });
});

describe("the one nested row", () => {
  it("draws the vendor's Finances with the real sub-rows (Balance & payouts, Payments, Refunds, Statements, Tax info)", () => {
    const finances = DEMO_TABS.vendor.find((tab) => tab.id === "financials")!;
    const real = vendorPortal.sections.find((section) => section.section === "financials")!;
    expect(finances.subItems?.map((sub) => sub.label)).toEqual(real.tabs.map((tab) => tab.label));
  });

  it("nests nothing else", () => {
    const nested = (Object.keys(DEMO_TABS) as DemoPortal[]).flatMap((portal) =>
      DEMO_TABS[portal].filter((tab) => tab.subItems?.length).map((tab) => `${portal}:${tab.id}`),
    );
    expect(nested).toEqual(["vendor:financials"]);
  });
});
