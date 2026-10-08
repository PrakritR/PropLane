// @vitest-environment jsdom
//
// Captain, Oct 7: Leases gets Filter + Lease settings beside the round +; Calendar has ONE round +
// (Add availability lives in its menu, no separate clock icon); Calendar, Bookings, Promotion
// (Listing sites) and Communication carry an Integrations icon that lands on their section of
// Settings -> Integrations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const navigate = vi.fn();
let demo = false;
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => demo }));

import { ManagerIntegrationsAction } from "@/components/portal/manager-integrations-action";
import { leaseUpdatedWithinWindow } from "@/components/portal/lease-filter-fields";
import { managerIntegrationsHref, managerSettingsGearHref } from "@/lib/portal-settings-section";

const src = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

beforeEach(() => {
  navigate.mockClear();
  demo = false;
});
afterEach(() => cleanup());

describe("Integrations icon", () => {
  it.each([
    ["google", "/portal/profile?tab=spreadsheets&integration=google"],
    ["bookings", "/portal/profile?tab=spreadsheets&integration=bookings"],
    ["posting", "/portal/profile?tab=spreadsheets&integration=posting"],
    ["messages", "/portal/profile?tab=spreadsheets&integration=messages"],
  ] as const)("%s opens its Integrations section and no dialog", async (section, href) => {
    expect(managerIntegrationsHref(section)).toBe(href);
    render(<ManagerIntegrationsAction section={section} />);
    const icon = await screen.findByRole("button", { name: "Integrations" });
    expect(icon.getAttribute("data-integrations-target")).toBe(href);
    expect(icon.textContent?.trim()).toBe("");
    fireEvent.click(icon);
    expect(navigate).toHaveBeenCalledWith(href);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("draws nothing on /demo, which has no Integrations page", async () => {
    demo = true;
    render(<ManagerIntegrationsAction section="google" />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Integrations" })).toBeNull());
  });

  it("every section it can point at exists on the Integrations page", () => {
    const panel = src("src/components/portal/manager-integrations-panel.tsx");
    for (const id of ["messages", "bookings", "posting", "google"]) expect(panel).toContain(`id: "${id}"`);
  });

  it("rides the header of Calendar, Bookings, Promotion (Listing sites only) and Communication", () => {
    expect(src("src/components/portal/portal-calendar.tsx")).toContain('<ManagerIntegrationsAction section="google"');
    expect(src("src/components/portal/pro-bookings.tsx")).toContain('<ManagerIntegrationsAction section="bookings"');
    expect(src("src/components/portal/pro-promotion.tsx")).toMatch(/showSites \? <ManagerIntegrationsAction section="posting"/);
    expect(src("src/components/portal/pro-communication.tsx")).toContain('<ManagerIntegrationsAction section="messages"');
  });

  it("is a plain icon action: PortalIconAction with a Plug glyph, never a labeled pill", () => {
    const action = src("src/components/portal/manager-integrations-action.tsx");
    expect(action).toContain("<PortalIconAction");
    expect(action).toContain("icon={Plug}");
    expect(action).toContain('label="Integrations"');
    expect(src("src/components/portal/portal-list-control-stack.tsx")).toMatch(/Plug, \/\/ Integrations/);
  });
});

describe("Leases header", () => {
  const leases = src("src/components/portal/pro-leases.tsx");

  it("reads Filter, Lease settings gear, then the round +", () => {
    const actions = leases.slice(leases.indexOf("const leasesListActions"));
    expect(actions.indexOf("{leasesFilterSheet}")).toBeGreaterThan(-1);
    expect(actions.indexOf("{leasesFilterSheet}")).toBeLessThan(actions.indexOf('<ManagerSettingsGear target="leases"'));
    expect(leases.indexOf("actions={leasesListActions}")).toBeLessThan(leases.indexOf("primary={"));
    expect(leases).toContain('data-attr="leases-add-top"');
    expect(leases).toContain('label="Lease settings"');
  });

  it("the + opens Send lease (generate for a resident, or read an uploaded lease) and nothing else", () => {
    expect(leases).toContain("onClick={() => setAddLeaseOpen(true)}");
    expect(leases).toMatch(/<LeaseSendSheet[\s\S]{0,80}pickResident/);
    expect(leases).not.toMatch(/icon=\{Upload\}/);
  });

  it("the gear is a link to the Leases section of Settings -> Automations", () => {
    expect(managerSettingsGearHref("leases")).toBe("/portal/profile?tab=applicationsLeases#leases");
    expect(src("src/components/portal/workspace-applications-leases-settings.tsx")).toContain(
      '<PortalSettingsSection id="leases" title="Leases">',
    );
  });

  it("Filter filters by property, stage and last-updated window, and resets all three", () => {
    expect(leases).toContain("<LeaseFilterFields");
    expect(leases).toContain("filterFieldCount={3}");
    expect(leases).toContain("onReset={clearAllFilters}");
    expect(leases).toMatch(/stageFilters\.includes\(row\.stageLabel/);
    expect(leases).toMatch(/leaseUpdatedWithinWindow\(row\.updatedAtIso/);
  });

  it("the updated window keeps recent leases and never hides one with an unreadable date", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(leaseUpdatedWithinWindow("2026-10-05T12:00:00Z", "7d", now)).toBe(true);
    expect(leaseUpdatedWithinWindow("2026-09-20T12:00:00Z", "7d", now)).toBe(false);
    expect(leaseUpdatedWithinWindow("2026-09-20T12:00:00Z", "30d", now)).toBe(true);
    expect(leaseUpdatedWithinWindow("2026-06-01T12:00:00Z", "90d", now)).toBe(false);
    expect(leaseUpdatedWithinWindow("2020-01-01T00:00:00Z", "any", now)).toBe(true);
    expect(leaseUpdatedWithinWindow("not a date", "7d", now)).toBe(true);
  });
});

describe("Calendar header", () => {
  const panels = src("src/components/portal/portal-calendar-panels.tsx");
  const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));

  it("has one round + in the studio band and no separate Availability icon", () => {
    expect(studio).not.toContain('label="Availability"');
    expect(studio).not.toContain("availabilityMenu");
    expect(studio.match(/<PortalPrimaryIconAction/g)?.length).toBe(1);
  });

  it("Add availability is in the + menu and opens the availability form", () => {
    expect(studio).toMatch(/data-attr="calendar-add-availability" onSelect=\{\(\) => openAddAvailability\(\)\}/);
    expect(studio).toContain("<CalendarAvailabilityDialog");
  });
});
