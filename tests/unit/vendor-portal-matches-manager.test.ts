import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorPortal } from "@/lib/portals/vendor";
import { NATIVE_BOTTOM_NAV_VENDOR_PRIMARY } from "@/lib/native/portal-bottom-nav";
import {
  parseVendorWorkOrderTab,
  VENDOR_WORK_ORDER_TAB_ORDER,
} from "@/lib/vendor-work-order-tabs";
import { vendorLinkPaths } from "@/lib/tools/domains/portal-links";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("vendor portal matches manager chrome", () => {
  it("labels Communication, not Inbox, and has no Payments nav section", () => {
    const communication = vendorPortal.sections.find((s) => s.section === "communication");
    expect(communication?.label).toBe("Communication");
    expect(vendorPortal.sections.some((s) => s.section === "payments")).toBe(false);
    expect(vendorPortal.sections.some((s) => s.label === "Inbox")).toBe(false);
    expect(vendorPortal.sections.find((s) => s.section === "financials")?.tabs.map((t) => t.id)).toEqual([
      "income",
      "invoices",
      "payouts",
    ]);
  });

  it("native bar is Services · Calendar · Dashboard · Communication", () => {
    expect([...NATIVE_BOTTOM_NAV_VENDOR_PRIMARY]).toEqual([
      "work-orders",
      "calendar",
      "dashboard",
      "communication",
    ]);
  });

  it("Services tabs are Pending / Upcoming / Past, with legacy quote URLs mapped", () => {
    expect([...VENDOR_WORK_ORDER_TAB_ORDER]).toEqual(["pending", "upcoming", "past"]);
    expect(parseVendorWorkOrderTab("quote")).toBe("pending");
    expect(parseVendorWorkOrderTab("tour")).toBe("pending");
    expect(parseVendorWorkOrderTab("scheduled")).toBe("upcoming");
    expect(parseVendorWorkOrderTab("completed")).toBe("past");
  });

  it("Communication uses the shared shell titled Communication and always-on setup cards", () => {
    const comm = read("src/components/portal/vendor-communication.tsx");
    expect(comm).toContain('title="Communication"');
    expect(comm).not.toContain('title="Inbox"');
    expect(comm).toContain("PortalCommunicationShell");
    expect(comm).toContain("PortalPrimaryIconAction");
    expect(comm).toContain("VendorWorkNumberCard");
    const cards = read("src/components/portal/vendor-work-number-card.tsx");
    expect(cards).toContain("Set up work number");
    expect(cards).toContain("Set up work email");
  });

  it("dashboard uses the shared home layout", () => {
    const dash = read("src/components/portal/vendor-dashboard.tsx");
    expect(dash).toContain("PortalHomeLayout");
    expect(dash).toContain("AttentionPanel");
    expect(dash).toContain("UpcomingPanel");
    expect(dash).toContain("KpiCard");
  });

  it("calendar and payouts fold into the shared surfaces", () => {
    expect(read("src/components/portal/portal-calendar.tsx")).toContain('portal === "vendor"');
    expect(read("src/lib/render-portal-section.tsx")).toContain('portal="vendor"');
    expect(read("src/lib/render-portal-section.tsx")).toContain("/financials/payouts");
    expect(vendorLinkPaths().payments).toBe("/vendor/financials/payouts");
  });
});
