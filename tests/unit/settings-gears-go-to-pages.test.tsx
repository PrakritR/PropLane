// @vitest-environment jsdom
//
// Phase 3 (captain, Oct 7): "settings that don't lead to settings page remove the pop up,
// settings should go to page". Every list-page gear is a link to a real Settings page and
// section; its pop-up is gone and its controls live in that section.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));

import { ManagerSettingsGear } from "@/components/portal/manager-settings-gear";
import {
  MANAGER_SETTINGS_GEAR_TARGETS,
  managerSettingsGearHref,
  managerSettingsProfilePath,
} from "@/lib/portal-settings-section";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const exists = (path: string) => existsSync(join(process.cwd(), path));

beforeEach(() => navigate.mockClear());
afterEach(() => cleanup());

describe("ManagerSettingsGear", () => {
  it.each([
    ["payments", "/portal/profile?tab=payments#rent-and-fees"],
    ["reminders", "/portal/profile?tab=messaging#what-proplane-sends"],
    ["leases", "/portal/profile?tab=applicationsLeases#leases"],
    ["tours", "/portal/profile?tab=applicationsLeases#tours"],
    ["moveInForms", "/portal/profile?tab=applicationsLeases#move-in-forms"],
    ["screening", "/portal/profile?tab=applicationsLeases#screening"],
    ["vendors", "/portal/profile?tab=applicationsLeases#vendors"],
  ] as const)("the %s gear navigates to its Settings URL and opens no dialog", (target, href) => {
    expect(managerSettingsGearHref(target)).toBe(href);
    render(<ManagerSettingsGear target={target} label="Some settings" />);
    const gear = screen.getByRole("button", { name: "Some settings" });
    expect(gear.getAttribute("data-gear-target")).toBe(href);
    fireEvent.click(gear);
    expect(navigate).toHaveBeenCalledWith(href);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("every target is a real Settings tab that is not a removed tab id", () => {
    const real = new Set(["payments", "messaging", "applicationsLeases"]);
    for (const { tab } of Object.values(MANAGER_SETTINGS_GEAR_TARGETS)) expect(real.has(tab)).toBe(true);
  });

  it("reminder links point at Communication, never the removed ?tab=reminders", () => {
    expect(managerSettingsProfilePath("automation")).toBe("/portal/profile?tab=messaging");
    const panels = read("src/components/portal/pro-portal-settings-panels.tsx");
    expect(panels).not.toContain("tab=reminders");
  });
});

describe("list-page gears link to Settings; their pop-ups are gone", () => {
  it("Payments list (and the resident record's payments) gear -> Rent & fees / Communication", () => {
    const payments = read("src/components/portal/pro-payments.tsx");
    expect(payments).toContain("<ManagerSettingsGear");
    expect(payments).not.toContain("ManagerPortalSettingsModal");
    expect(payments).not.toContain("setPaymentSettingsOpen");
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).not.toContain("ManagerPortalSettingsModal");
    expect(residents).not.toContain("ProPortalSettingsModal");
    expect(residents).not.toContain("setResidentPaymentSettingsOpen");
  });

  it("resident-record Tours gear -> Tours section; Services gear is removed", () => {
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).toContain('target="tours"');
    expect(residents).not.toContain("openResidentDetailSettings");
    expect(residents).not.toContain("residentsSettingsEntry");
    expect(residents).not.toContain("resident-services-settings");
  });

  it("property Pricing, Services and Promotion gears are removed", () => {
    expect(read("src/components/portal/property-pricing-panel.tsx")).not.toContain("ps40-settings");
    expect(exists("src/components/portal/property-pricing-settings-modal.tsx")).toBe(false);
    const services = read("src/components/portal/pro-property-requests-panel.tsx");
    expect(services).not.toContain("property-services-settings");
    expect(services).not.toContain("PortalPropertySectionSettingsModal");
    const promotion = read("src/components/portal/pro-property-promotion-panel.tsx");
    expect(promotion).not.toContain("property-promotion-settings-open");
    expect(promotion).not.toContain("PortalPropertySectionSettingsModal");
    // The Zillow switch stays on the Listing sites row.
    expect(read("src/components/portal/listing-sites-panel.tsx")).toContain("property-promotion-zillow-toggle");
  });

  it("property Forms and Move-in gears -> Move-in forms section", () => {
    for (const file of ["src/components/portal/pro-property-forms-panel.tsx", "src/components/portal/pro-property-room-move-in-panel.tsx"]) {
      const src = read(file);
      expect(src).toContain('target="moveInForms"');
      expect(src).toContain('dataAttr="property-move-in-settings-open"');
      expect(src).not.toContain("usePropertyMoveInSettings");
    }
    expect(exists("src/components/portal/property-move-in-settings.tsx")).toBe(false);
  });

  it("Background checks gear -> Screening; Vendors gear -> Vendors", () => {
    const checks = read("src/components/portal/pro-background-checks.tsx");
    expect(checks).toContain('target="screening"');
    expect(checks).not.toContain("ManagerScreeningSettingsModal");
    const vendors = read("src/components/portal/pro-vendors-panel.tsx");
    expect(vendors).toContain('target="vendors"');
    expect(vendors).not.toContain("ManagerVendorDefaultsModal");
    expect(exists("src/components/portal/pro-screening-settings.tsx")).toBe(false);
    expect(exists("src/components/portal/pro-vendor-defaults-modal.tsx")).toBe(false);
  });

  it("Vendor Services gear -> Trades & service area through VendorSettingsGear", () => {
    const services = read("src/components/portal/vendor-work-orders-panel.tsx");
    expect(services).toContain('section="services"');
    expect(services).not.toContain("VendorSectionSettingsModal");
    expect(exists("src/components/portal/vendor-section-settings-modal.tsx")).toBe(false);
  });

  it("Dashboard Customize stays (a view preference, not a setting)", () => {
    expect(read("src/components/portal/pro-dashboard.tsx")).toMatch(/Customize/);
  });

  it("dead gear code is gone", () => {
    expect(exists("src/components/portal/resident-detail-subsection-chrome.tsx")).toBe(false);
    expect(exists("src/components/portal/pro-work-number-button.tsx")).toBe(false);
    expect(read("src/components/portal/property-form-automation-chrome.tsx")).not.toContain("onSettings");
    expect(read("src/components/portal/inspections-panel.tsx")).not.toContain("ProPortalSettingsModal");
    expect(read("src/components/portal/pro-house-properties-panel.tsx")).not.toContain("ManagerPortalSettingsModal");
    expect(read("src/components/portal/pro-applications.tsx")).not.toContain("ManagerScreeningSettingsModal");
  });
});

describe("the Pricing step of the listing wizard carries the fields the Pricing gear's pop-up held", () => {
  const editor = read("src/components/portal/listing-wizard-v2/listing-editor.tsx");
  it.each([
    ["Processing fee paid by", "serviceFeePayer"],
    ["Coverage code", "serviceFeeWaiverCode"],
    ["Rent due", "rentDueDayMode"],
    ["Automatic late fees", "lateFeeEnabled"],
    ["Late fee amount", "lateFeeAmount"],
    ["Grace days", "lateFeeGraceDays"],
  ])("%s is edited in the wizard Pricing step (%s)", (label, field) => {
    expect(editor).toContain(label === "Processing fee paid by" ? "Processing fee" : label);
    expect(editor).toContain(field);
  });
});
