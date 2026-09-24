/**
 * Vendors is its own section under Operations. It used to live under Services,
 * then as a Teams tab; both retired paths must still resolve so bookmarks and
 * sent links keep working. The Teams page itself is gone — co-managers live
 * under Settings → Workspaces (PLAN-0923-1934).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorDetailHref, vendorListHref } from "@/lib/portal-detail-routes";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";

describe("Vendors section (Teams page removed)", () => {
  it("Vendors is a section of its own, next to Services, with no sub-tabs", () => {
    const vendors = proPortal.sections.find((s) => s.section === "vendors");
    expect(vendors?.label).toBe("Vendors");
    expect(vendors?.tabs ?? []).toEqual([]);
    const ids = proPortal.sections.map((s) => s.section);
    expect(ids.indexOf("vendors")).toBe(ids.indexOf("services") + 1);
    const ops = PORTAL_NAV_GROUPS.pro.find((g) => g.id === "operations");
    expect(ops?.sections[0]).toBe("vendors");
  });

  it("Teams is not a manager nav section — team is Settings → Workspaces", () => {
    expect(proPortal.sections.find((s) => s.section === "teams")).toBeUndefined();
  });

  it("renders the vendors section and redirects the retired Teams vendors tab to it", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('section === "vendors"');
    expect(src).toContain("redirect(`${def.basePath}/vendors${vendorId}`)");
    expect(src).not.toContain("redirect(`${def.basePath}/teams/vendors");
    const panel = readFileSync(join(process.cwd(), "src/components/portal/pro-vendors-panel.tsx"), "utf8");
    expect(panel).toContain('title="Vendors"');
    expect(panel).not.toContain('title="Teams"');
    expect(panel).not.toContain("Vendor catalog");
    expect(panel).not.toContain("ManagerVendorCatalogModal");
  });

  it("keeps Teams out of the sidebar — team management lives in Settings", () => {
    expect(PORTAL_NAV_GROUPS.pro.find((g) => g.id === "team")).toBeUndefined();
    expect(PORTAL_NAV_GROUPS.pro.some((g) => g.sections.includes("teams"))).toBe(false);
  });
});

describe("Calendar and Bookings are separate sidebar entries", () => {
  it("lists Calendar and Bookings under Operations", () => {
    const group = PORTAL_NAV_GROUPS.pro.find((g) => g.id === "operations");
    expect(group?.sections).toEqual(["vendors", "tasks", "calendar", "bookings", "communication"]);
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
  it("point at the Vendors section, not the retired Teams tab or Services path", () => {
    expect(vendorListHref("/portal")).toBe("/portal/vendors");
    expect(vendorDetailHref("/portal", "vend-1")).toBe("/portal/vendors/vend-1/overview");
  });

  it("encodes a vendor id with awkward characters", () => {
    expect(vendorDetailHref("/portal", "a b/c")).toBe("/portal/vendors/a%20b%2Fc/overview");
  });

  it("still resolves the retired /services/vendors and /teams/vendors paths", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('if (servicesTab === "vendors")');
    expect(src).toContain('tabParts?.[0] === "vendors"');
    expect(src).not.toContain('!["requests", "work-orders", "vendors"].includes(servicesTab)');
  });

  it("redirects legacy /relationships and /teams to Settings → Workspaces", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/render-portal-section.tsx"), "utf8");
    expect(src).toContain('section === "relationships"');
    expect(src).toContain("/profile?tab=workspaces");
  });
});
