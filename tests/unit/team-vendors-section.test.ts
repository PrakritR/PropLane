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
import { vendorDetailHref, vendorListHref } from "@/lib/portal-detail-routes";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";

describe("Team is two sidebar entries, not one tabbed page", () => {
  it("lists Managers and Vendors as separate sections", () => {
    // Same shape Tenancy uses for Residents / Payments / Services — two nav rows under one
    // heading, rather than a tab strip inside a single page.
    const managers = proPortal.sections.find((s) => s.section === "relationships");
    const vendors = proPortal.sections.find((s) => s.section === "vendors");
    expect(managers?.label).toBe("Managers");
    expect(vendors?.label).toBe("Vendors");
    // Neither carries sub-tabs — the split IS the navigation.
    expect(managers?.tabs ?? []).toEqual([]);
    expect(vendors?.tabs ?? []).toEqual([]);
  });

  it("groups both under the Team heading, in order", () => {
    const group = PORTAL_NAV_GROUPS.pro.find((g) => g.id === "team");
    expect(group?.label).toBe("Team");
    expect(group?.sections).toEqual(["relationships", "vendors"]);
  });
});

describe("Calendar and Bookings are separate sidebar entries", () => {
  it("lists Calendar and Bookings under Operations", () => {
    const group = PORTAL_NAV_GROUPS.pro.find((g) => g.id === "operations");
    expect(group?.sections).toEqual(["tasks", "calendar", "bookings", "communication"]);
  });

  it("Calendar is schedule-only — no in-page tabs", () => {
    const calendar = proPortal.sections.find((s) => s.section === "calendar");
    expect(calendar?.label).toBe("Calendar");
    expect(calendar?.tabs ?? []).toEqual([]);
  });

  it("Bookings is its own section", () => {
    const bookings = proPortal.sections.find((s) => s.section === "bookings");
    expect(bookings?.label).toBe("Bookings");
    expect(bookings?.tabs ?? []).toEqual([]);
  });

  it("renders both sections rather than redirecting away", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('section === "calendar"');
    expect(src).toContain('section === "bookings"');
    expect(src).toContain("loadPortalCalendar()");
    expect(src).not.toContain('section === "calendar") {\n    redirect(`${def.basePath}/tours/pending`);');
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
  it("point at the Vendors section, not the old Services path", () => {
    expect(vendorListHref("/portal")).toBe("/portal/vendors");
    expect(vendorDetailHref("/portal", "vend-1")).toBe("/portal/vendors/vend-1");
  });

  it("encodes a vendor id with awkward characters", () => {
    expect(vendorDetailHref("/portal", "a b/c")).toBe("/portal/vendors/a%20b%2Fc");
  });

  it("still resolves the retired /services/vendors path", () => {
    // A redirect, not a 404 — the old URL is in bookmarks and in links already sent.
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('if (servicesTab === "vendors")');
    expect(src).toContain("/vendors");
    // And it must not still be treated as a live services tab.
    expect(src).not.toContain('!["requests", "work-orders", "vendors"].includes(servicesTab)');
  });
});
