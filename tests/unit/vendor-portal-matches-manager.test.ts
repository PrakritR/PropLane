import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorPortal } from "@/lib/portals/vendor";
import { NATIVE_BOTTOM_NAV_VENDOR_PRIMARY } from "@/lib/native/portal-bottom-nav";
import {
  parseVendorWorkOrderTab,
  VENDOR_WORK_ORDER_TAB_LABELS,
  VENDOR_WORK_ORDER_TAB_ORDER,
} from "@/lib/vendor-work-order-tabs";
import { vendorLinkPaths } from "@/lib/tools/domains/portal-links";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("vendor portal matches manager chrome", () => {
  it("labels Communication, not Inbox, and has no Payments nav section", () => {
    const communication = vendorPortal.sections.find((s) => s.section === "communication");
    expect(communication?.label).toBe("Communication");
    // Money group: Incoming payments (`payments`), Outgoing payments (`outgoing`), Finances, Documents.
    expect(vendorPortal.sections.find((s) => s.section === "payments")?.label).toBe("Incoming payments");
    expect(vendorPortal.sections.find((s) => s.section === "outgoing")?.label).toBe("Outgoing payments");
    expect(vendorPortal.sections.some((s) => s.label === "Inbox")).toBe(false);
    const finances = vendorPortal.sections.find((s) => s.section === "financials");
    expect(finances?.label).toBe("Finances");
    expect(finances?.tabs.map((t) => t.label)).toEqual(["Overview", "Balance & payouts", "Refunds"]);
    expect(finances?.tabs.map((t) => t.id)).toEqual(["overview", "balance", "refunds"]);
  });

  it("native bar is Services · Calendar · Dashboard · Communication", () => {
    expect([...NATIVE_BOTTOM_NAV_VENDOR_PRIMARY]).toEqual([
      "work-orders",
      "calendar",
      "dashboard",
      "communication",
    ]);
  });

  it("Services tabs are the one service vocabulary (Open, Assigned, Scheduled, Completed), with legacy URLs mapped", () => {
    expect([...VENDOR_WORK_ORDER_TAB_ORDER]).toEqual(["open", "assigned", "scheduled", "completed"]);
    expect(VENDOR_WORK_ORDER_TAB_ORDER.map((id) => VENDOR_WORK_ORDER_TAB_LABELS[id])).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
    expect(parseVendorWorkOrderTab("pending")).toBe("open");
    expect(parseVendorWorkOrderTab("potential")).toBe("open");
    expect(parseVendorWorkOrderTab("quote")).toBe("open");
    expect(parseVendorWorkOrderTab("tour")).toBe("open");
    expect(parseVendorWorkOrderTab("upcoming")).toBe("scheduled");
    expect(parseVendorWorkOrderTab("current")).toBe("scheduled");
    expect(parseVendorWorkOrderTab("scheduled")).toBe("scheduled");
    expect(parseVendorWorkOrderTab("past")).toBe("completed");
    expect(parseVendorWorkOrderTab("completed")).toBe("completed");
  });

  it("Communication uses the shared shell titled Communication and always-on setup cards", () => {
    const comm = read("src/components/portal/vendor-communication.tsx");
    expect(comm).toContain('title="Communication"');
    expect(comm).not.toContain('title="Inbox"');
    expect(comm).toContain("PortalCommunicationShell");
    expect(comm).toContain("PortalPrimaryIconAction");
    expect(comm).toContain("VendorWorkNumberCard");
    const cards = read("src/components/portal/vendor-work-number-card.tsx");
    // The PropLane work NUMBER card is retired (vendors never own a number); the email card stays.
    expect(cards).not.toContain("Set up work number");
    expect(cards).toContain("Set up work email");
  });

  it("dashboard uses the shared home layout", () => {
    const dash = read("src/components/portal/vendor-dashboard.tsx");
    expect(dash).toContain("PortalHomeLayout");
    expect(dash).toContain("AttentionPanel");
    expect(dash).toContain("UpcomingPanel");
    expect(dash).toContain("KpiCard");
  });

  it("calendar and finance setup fold into the shared surfaces", () => {
    expect(read("src/components/portal/portal-calendar.tsx")).toContain('portal === "vendor"');
    expect(read("src/lib/render-portal-section.tsx")).toContain('portal="vendor"');
    expect(read("src/lib/vendor-money-routes.ts")).toContain("/payments/");
    expect(vendorLinkPaths().payments).toBe("/vendor/payments/pending");
  });

  it("has no Tasks nav and redirects /vendor/tasks to services", () => {
    expect(vendorPortal.sections.some((s) => s.section === "tasks")).toBe(false);
    expect(vendorLinkPaths().tasks).toBe("/vendor/work-orders/pending");
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('kind === "vendor" && section === "tasks"');
    expect(render).toContain("/work-orders/pending");
    expect(read("src/components/portal/vendor-dashboard.tsx")).not.toContain("/vendor/tasks");
  });

  it("vendor calendar (C155 superseded, captain 2026-09-26) is the shared week-grid engine with All/Services/Availability tabs", () => {
    const calendar = read("src/components/portal/vendor-calendar-panel.tsx");
    // The agenda-only redesign (C155) was reverted: the vendor Calendar is now
    // the same week-grid engine the manager Calendar uses, in `vendorViewer`
    // mode, filtered by a kind tab instead of a view-mode switcher.
    expect(calendar).toContain("PortalCalendarPanels");
    expect(calendar).toContain("vendorViewer");
    expect(calendar).toContain("onVendorAvailabilityEdit");
    expect(calendar).toContain("hideViewModeControl");
    expect(calendar).toContain("VendorCalendarIntegrationsAction");
    // Set-availability edits and removal both go through the one canonical
    // editor — clicking a painted block re-opens it rather than a bespoke
    // grid-level delete.
    expect(calendar).toContain("VendorAvailabilityEditor");
    expect(calendar).toContain("VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT");
    expect(read("src/lib/portal-detail-routes.ts")).toContain('["all", "services", "availability"]');
    // The old "Flexible weekday" / "Add work" vendor-only chrome never
    // returns — those are vendorDayFlexibility/vendorCalendarActions, both
    // deliberately left unset here.
    expect(calendar).not.toContain("vendorDayFlexibility");
    expect(calendar).not.toContain("Add work");
    expect(calendar).not.toContain("Mark day as flexible");
    expect(calendar).not.toContain("fetchVendorAssignedTasks");
    expect(read("src/lib/vendor-availability.ts")).toContain("convertFlexibleWeeklyRulesToWindows");
  });

  it("finances uses a filter sheet, an Add-payment primary, payout setup, and doors the Payouts tab to Settings", () => {
    const finances = read("src/components/portal/vendor-finances-panel.tsx");
    expect(finances).toContain("PortalFilterSortSheet");
    // "Request payment" was renamed to the shared "Add <noun>" list-band
    // primary shape (N025) — this assertion rotted after that fix landed.
    expect(finances).toContain('portalListAddPrimaryLabel("payment")');
    // The band's gear opens Settings → Payouts (vendor-portal-redesign-1006); the
    // Bank icon on the balance card keeps the Add bank flow.
    expect(finances).toContain('<VendorSettingsGear section="payments"');
    // The Bank icon lives on the Balance & payouts card now.
    expect(read("src/components/portal/vendor-finances-balance.tsx")).toContain('label="Bank"');
    // Payouts is one page now, mounted at Settings → Payouts
    // (PLAN-0920-1500) — the Finances "payouts" tabId never reaches this
    // component; `render-portal-section.tsx` redirects it first. 
    expect(finances).not.toContain("PortalPayoutsPanel");
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('finTab === "payouts"');
    // Settings › Payouts keeps only bank accounts + schedule; the bare payouts id now opens Balance & payouts.
    expect(render).toContain("${def.basePath}/financials/balance");
    expect(finances).not.toContain("ReportFilterBar");
    expect(finances).toContain("VendorQuoteWizard");
    expect(read("src/components/portal/vendor-quote-wizard.tsx")).not.toContain("VendorAddChooser");
  });

  it("documents uses the Services-style tab band and upload workspace", () => {
    const docs = read("src/components/portal/vendor-documents-panel.tsx");
    expect(docs).toContain("RecordTabBand");
    expect(docs).toContain("VendorUploadDocumentWorkspace");
    expect(docs).not.toContain("VENDOR_DOCUMENT_HINTS");
    expect(docs).not.toContain("TabNav");
  });
});
