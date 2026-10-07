// Vendor Settings pages + list-band gears (vendor-portal-redesign-1006).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VENDOR_LIST_GEAR_TARGETS,
  VENDOR_SETTINGS_RAIL,
  resolveVendorSettingsTab,
  vendorListGearHref,
  vendorSettingsHref,
  vendorSettingsPageLabel,
} from "@/lib/portals/vendor-settings-pages";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("settings rail", () => {
  it("groups the pages Profile · Business · Money · Communication, with the approved pages in each", () => {
    expect(VENDOR_SETTINGS_RAIL.map((g) => g.label)).toEqual(["Profile", "Business", "Money", "Communication"]);
    const labels = (group: string) => VENDOR_SETTINGS_RAIL.find((g) => g.label === group)!.pages.map((p) => p.label);
    expect(labels("Profile")).toEqual(expect.arrayContaining(["Profile", "Login & security"]));
    expect(labels("Business")).toEqual(expect.arrayContaining(["Business details", "Trades & service area", "Licenses & insurance", "Integrations"]));
    expect(labels("Money")).toEqual(["Payouts", "Invoicing"]);
    expect(labels("Communication")).toEqual(["Phone & notifications", "Quick replies", "Work number & email"]);
  });

  it("has no duplicate page ids", () => {
    const ids = VENDOR_SETTINGS_RAIL.flatMap((g) => g.pages.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("old deep links keep resolving: payouts and messaging keep their ids, the folded ones alias forward", () => {
    expect(resolveVendorSettingsTab("payouts")).toBe("payouts");
    expect(resolveVendorSettingsTab("messaging")).toBe("messaging");
    expect(resolveVendorSettingsTab("work")).toBe("business");
    expect(resolveVendorSettingsTab("work-email")).toBe("business");
    expect(resolveVendorSettingsTab("workspace-access")).toBe("business");
    expect(resolveVendorSettingsTab("notifications")).toBe("messaging");
    expect(resolveVendorSettingsTab("nope")).toBeNull();
    expect(resolveVendorSettingsTab(null)).toBeNull();
  });
});

describe("the gear in every vendor list band", () => {
  it("opens the matching Settings page", () => {
    expect(VENDOR_LIST_GEAR_TARGETS).toEqual({
      services: "capabilities",
      payments: "payouts",
      reviews: "profile",
      communication: "quick-replies",
    });
    expect(vendorListGearHref("services")).toBe("/vendor/profile?tab=capabilities");
    expect(vendorListGearHref("payments")).toBe("/vendor/profile?tab=payouts");
    expect(vendorListGearHref("reviews")).toBe("/vendor/profile?tab=profile");
    expect(vendorListGearHref("communication")).toBe("/vendor/profile?tab=quick-replies");
    expect(vendorSettingsHref("quick-replies", "/vendor")).toBe("/vendor/profile?tab=quick-replies");
  });

  it("targets are real rail pages with the labels the plan names", () => {
    expect(vendorSettingsPageLabel(VENDOR_LIST_GEAR_TARGETS.services)).toBe("Trades & service area");
    expect(vendorSettingsPageLabel(VENDOR_LIST_GEAR_TARGETS.payments)).toBe("Payouts");
    expect(vendorSettingsPageLabel(VENDOR_LIST_GEAR_TARGETS.reviews)).toBe("Profile");
    expect(vendorSettingsPageLabel(VENDOR_LIST_GEAR_TARGETS.communication)).toBe("Quick replies");
  });

  it("Reviews, Payments and Communication render the gear link, not a local pop-up", () => {
    expect(read("src/components/portal/vendor-reviews-panel.tsx")).toContain('<VendorSettingsGear section="reviews"');
    expect(read("src/components/portal/vendor-finances-panel.tsx")).toContain('<VendorSettingsGear section="payments"');
    const comm = read("src/components/portal/vendor-communication.tsx");
    expect(comm).toContain('<VendorSettingsGear');
    expect(comm).not.toContain("VendorSectionSettingsModal");
  });

  it("the Services panel's old settings pop-up is a redirect shim, so its gear lands on Trades & service area too", () => {
    const shim = read("src/components/portal/vendor-section-settings-modal.tsx");
    expect(shim).not.toContain("VendorNotificationSettingsPane");
    expect(shim).toContain("vendorListGearHref");
    expect(shim).toContain("return null");
  });
});

describe("settings panel", () => {
  const panel = read("src/components/portal/vendor-settings-panel.tsx");
  it("renders the rail from the shared list (uppercase group labels, one rail + pages)", () => {
    expect(panel).toContain("VENDOR_SETTINGS_RAIL");
    expect(panel).toContain("settings-nav-");
    expect(panel).not.toContain("PortalCollapsibleSection");
  });
  it("keeps the verify-phone control on Phone & notifications", () => {
    expect(panel).toContain('title="Verify your phone"');
    expect(panel).toMatch(/case "messaging":[\s\S]*PortalTextNotificationsBlock[\s\S]*VendorNotificationsPane/);
  });
  it("moves, not duplicates: each existing pane renders from exactly one page", () => {
    for (const component of ["VendorBusinessProfilePane", "VendorWorkIdentitySection", "VendorNotificationsPane", "PortalPayoutsSettingsPage", "VendorAvailabilityEditor"]) {
      const uses = panel.match(new RegExp(`<${component}\\b`, "g")) ?? [];
      expect(uses, component).toHaveLength(1);
    }
  });
});
