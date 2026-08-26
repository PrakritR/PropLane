/**
 * Vendors moved out of Services and into Team.
 *
 * They are PEOPLE a manager works with, which is what Team is about; under Services they sat
 * beside the work those people do, behind a permanent "(soon)" placeholder tab.
 *
 * Two things have to hold together or the move breaks navigation silently — the class of bug
 * AGENTS.md warns about, where a section compiles and tests pass while the URL goes nowhere:
 *
 *   1. the old `/services/vendors` path must still RESOLVE, because it is in bookmarks and in
 *      links already sent to people;
 *   2. the link builders must point at the NEW path, so a click does not pay a redirect and
 *      briefly light up the wrong nav section.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEAM_SECTION_TABS,
  TEAM_SECTION_TAB_LABELS,
  parseTeamSectionTab,
  teamSectionHref,
  vendorDetailHref,
  vendorListHref,
} from "@/lib/portal-detail-routes";
import { proPortal } from "@/lib/portals/pro";

describe("Team section tabs", () => {
  it("offers Managers and Vendors", () => {
    expect([...TEAM_SECTION_TABS]).toEqual(["managers", "vendors"]);
    expect(TEAM_SECTION_TAB_LABELS.managers).toBe("Managers");
    expect(TEAM_SECTION_TAB_LABELS.vendors).toBe("Vendors");
  });

  it("round-trips every tab", () => {
    for (const tab of TEAM_SECTION_TABS) {
      expect(parseTeamSectionTab(tab)).toBe(tab);
      expect(teamSectionHref("/portal", tab)).toBe(`/portal/relationships/${tab}`);
    }
  });

  it("lands an unknown or legacy sub-path on Managers rather than 404ing", () => {
    // `owner`, `manager`, `pending` and `linked` are the pre-tab sub-paths.
    for (const raw of ["", null, undefined, "owner", "manager", "pending", "linked", "bogus"]) {
      expect(parseTeamSectionTab(raw)).toBe("managers");
    }
  });

  it("is declared on the manager portal with both tabs", () => {
    const team = proPortal.sections.find((s) => s.section === "relationships");
    expect(team?.tabs?.map((t) => t.id)).toEqual(["managers", "vendors"]);
  });
});

describe("Services no longer carries Vendors", () => {
  it("has no sub-tabs of its own", () => {
    // Add-on services and work orders are presented as ONE queue; the vendors placeholder is gone.
    const services = proPortal.sections.find((s) => s.section === "services");
    expect(services?.tabs ?? []).toEqual([]);
  });

  it("keeps the two data models separate, as AGENTS.md requires", () => {
    // Presentation merged, storage NOT. Two stores must still exist independently.
    const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    expect(agents).toContain("portal_service_request_records");
    expect(agents).toContain("portal_work_order_records");
  });
});

describe("vendor links", () => {
  it("point at Team, not the old Services path", () => {
    expect(vendorListHref("/portal")).toBe("/portal/relationships/vendors");
    expect(vendorDetailHref("/portal", "vend-1")).toBe("/portal/relationships/vendors/vend-1");
  });

  it("encodes a vendor id with awkward characters", () => {
    expect(vendorDetailHref("/portal", "a b/c")).toBe("/portal/relationships/vendors/a%20b%2Fc");
  });

  it("still resolves the retired /services/vendors path", () => {
    // A redirect, not a 404 — the old URL is in bookmarks and in links already sent.
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('if (servicesTab === "vendors")');
    expect(src).toContain("/relationships/vendors");
    // And it must not still be treated as a live services tab.
    expect(src).not.toContain('!["requests", "work-orders", "vendors"].includes(servicesTab)');
  });
});
