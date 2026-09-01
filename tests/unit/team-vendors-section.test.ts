/**
 * Teams groups Managers and Vendors under one sidebar entry (like Payments
 * incoming/outgoing). Vendors used to live under Services; the retired paths must
 * still resolve so bookmarks and sent links keep working.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorDetailHref, vendorListHref } from "@/lib/portal-detail-routes";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";

describe("Teams sidebar dropdown (Managers + Vendors)", () => {
  it("lists Managers and Vendors as tabs on the Teams section", () => {
    const teams = proPortal.sections.find((s) => s.section === "teams");
    expect(teams?.label).toBe("Teams");
    expect(teams?.tabs.map((tab) => tab.id)).toEqual(["managers", "vendors"]);
    expect(teams?.tabs.map((tab) => tab.label)).toEqual(["Managers", "Vendors"]);
  });

  it("groups Teams under the Team heading", () => {
    const group = PORTAL_NAV_GROUPS.pro.find((g) => g.id === "team");
    expect(group?.label).toBe("Team");
    expect(group?.sections).toEqual(["teams"]);
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
    const services = proPortal.sections.find((s) => s.section === "services");
    expect(services?.tabs ?? []).toEqual([]);
  });

  it("keeps the two data models separate, as AGENTS.md requires", () => {
    const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
    expect(agents).toContain("portal_service_request_records");
    expect(agents).toContain("portal_work_order_records");
  });
});

describe("vendor links", () => {
  it("point at the Teams vendors tab, not the old Services path", () => {
    expect(vendorListHref("/portal")).toBe("/portal/teams/vendors");
    expect(vendorDetailHref("/portal", "vend-1")).toBe("/portal/teams/vendors/vend-1");
  });

  it("encodes a vendor id with awkward characters", () => {
    expect(vendorDetailHref("/portal", "a b/c")).toBe("/portal/teams/vendors/a%20b%2Fc");
  });

  it("still resolves the retired /services/vendors path", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('if (servicesTab === "vendors")');
    expect(src).toContain("/teams/vendors");
    expect(src).not.toContain('!["requests", "work-orders", "vendors"].includes(servicesTab)');
  });

  it("redirects legacy /vendors and /relationships paths", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('section === "vendors"');
    expect(src).toContain('section === "relationships"');
    expect(src).toContain("/teams/vendors");
    expect(src).toContain("/teams/managers");
  });
});
