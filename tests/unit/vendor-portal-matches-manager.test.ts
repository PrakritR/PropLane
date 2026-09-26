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
    expect(vendorPortal.sections.some((s) => s.section === "payments")).toBe(false);
    expect(vendorPortal.sections.some((s) => s.label === "Inbox")).toBe(false);
    expect(vendorPortal.sections.find((s) => s.section === "financials")?.tabs.map((t) => t.id)).toEqual([
      "income",
      "invoices",
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

  it("Services tabs are the pending/upcoming/past buckets, shown as Potential / Current / Past, with legacy quote URLs mapped", () => {
    expect([...VENDOR_WORK_ORDER_TAB_ORDER]).toEqual(["pending", "upcoming", "past"]);
    expect(parseVendorWorkOrderTab("quote")).toBe("pending");
    expect(parseVendorWorkOrderTab("tour")).toBe("pending");
    expect(parseVendorWorkOrderTab("scheduled")).toBe("upcoming");
    expect(parseVendorWorkOrderTab("completed")).toBe("past");
    // Ids/URLs are unchanged; only the displayed label reads the standard
    // list header's bucket names (spec:addendum-6).
    expect(VENDOR_WORK_ORDER_TAB_LABELS.pending).toBe("Potential");
    expect(VENDOR_WORK_ORDER_TAB_LABELS.upcoming).toBe("Current");
    expect(VENDOR_WORK_ORDER_TAB_LABELS.past).toBe("Past");
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

  it("calendar and finance setup fold into the shared surfaces", () => {
    expect(read("src/components/portal/portal-calendar.tsx")).toContain('portal === "vendor"');
    expect(read("src/lib/render-portal-section.tsx")).toContain('portal="vendor"');
    expect(read("src/lib/render-portal-section.tsx")).toContain("/financials/income");
    expect(vendorLinkPaths().payments).toBe("/vendor/financials/income");
  });

  it("has no Tasks nav and redirects /vendor/tasks to services", () => {
    expect(vendorPortal.sections.some((s) => s.section === "tasks")).toBe(false);
    expect(vendorLinkPaths().tasks).toBe("/vendor/work-orders/pending");
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('kind === "vendor" && section === "tasks"');
    expect(render).toContain("/work-orders/pending");
    expect(read("src/components/portal/vendor-dashboard.tsx")).not.toContain("/vendor/tasks");
  });

  it("vendor calendar (C155) is a day-grouped agenda with the shared availability editor, no view switcher", () => {
    const calendar = read("src/components/portal/vendor-calendar-panel.tsx");
    // The List/Day/Week/Month grid switcher is gone (C155); the panel is one
    // continuous chronological agenda grouped under date headers.
    expect(calendar).not.toContain('label: "List"');
    expect(calendar).not.toContain('label: "Day"');
    expect(calendar).not.toContain('label: "Week"');
    expect(calendar).not.toContain('label: "Month"');
    expect(calendar).not.toContain("vendorViewer");
    expect(calendar).toContain("groupMeetingsByDate");
    expect(calendar).toContain("agendaDateHeaderLabel");
    expect(calendar).toContain('data-attr="vendor-calendar-agenda-day"');
    // Still surfaces the shared canonical availability editor.
    expect(calendar).toContain("VendorAvailabilityEditor");
    expect(calendar).toContain("VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT");
    // Routing keeps the legacy view tabs alive for old links (`view` is
    // accepted and ignored by the panel itself).
    expect(read("src/lib/portal-detail-routes.ts")).toContain('["list", "day", "week", "month"]');
    expect(calendar).not.toContain("vendorDayFlexibility");
    expect(calendar).not.toContain("Add work");
    expect(calendar).not.toContain("Mark day as flexible");
    expect(calendar).not.toContain("fetchVendorAssignedTasks");
    expect(read("src/lib/vendor-availability.ts")).toContain("convertFlexibleWeeklyRulesToWindows");
  });

  it("finances uses a filter sheet, request payment, payout setup, and doors the Payouts tab to Settings", () => {
    const finances = read("src/components/portal/vendor-finances-panel.tsx");
    expect(finances).toContain("PortalFilterSortSheet");
    expect(finances).toContain("Request payment");
    expect(finances).toContain("Payout setup");
    // Payouts is one page now, mounted at Settings → Payouts
    // (PLAN-0920-1500) — the Finances "payouts" tabId never reaches this
    // component; `render-portal-section.tsx` redirects it first. Income still
    // keeps a quick "Payout setup" door into payment methods.
    expect(finances).not.toContain("PortalPayoutsPanel");
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('finTab === "payouts"');
    expect(render).toContain("${def.basePath}/profile?tab=payouts");
    expect(finances).not.toContain("ReportFilterBar");
    expect(finances).toContain("VendorQuoteWizard");
    expect(read("src/components/portal/vendor-quote-wizard.tsx")).not.toContain("VendorAddChooser");
  });

  it("documents uses the command bar and upload workspace", () => {
    const docs = read("src/components/portal/vendor-documents-panel.tsx");
    expect(docs).toContain("PortalListControlStack");
    expect(docs).toContain("VendorUploadDocumentWorkspace");
    expect(docs).not.toContain("VENDOR_DOCUMENT_HINTS");
    expect(docs).not.toContain("TabNav");
  });
});
