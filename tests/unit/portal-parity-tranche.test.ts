import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managerVendorSummaryJobHref } from "@/components/portal/pro-vendor-detail";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

describe("vendor profile parity", () => {
  it("keeps a matched catalog profile on its catalog URL while rendering the owned record", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel).toContain("const catalogRosterMatch");
    expect(panel).toContain('data-attr="vendor-catalog-matched-profile"');
    expect(panel).toContain("row={catalogRosterMatch}");
    expect(panel).toContain("detailHref={(tab) => vendorCatalogDetailHref(basePath, catalogDetailId, tab)}");
    // A matched catalog vendor swaps the header's Add for Open (record page), never a second Add.
    expect(panel).toContain('action.id === "add" ? { id: "open", label: "Open"');
  });

  it("routes summary jobs to the existing manager service detail buckets", () => {
    expect(managerVendorSummaryJobHref("/portal", { id: "open job", status: "awaiting_vendor" })).toBe("/portal/services/work-orders/open/open%20job");
    expect(managerVendorSummaryJobHref("/portal", { id: "scheduled", status: "scheduled" })).toBe("/portal/services/work-orders/scheduled/scheduled");
    expect(managerVendorSummaryJobHref("/portal", { id: "paid", status: "paid" })).toBe("/portal/services/work-orders/completed/paid");
  });

  it("makes history failures visible and starts a fresh coalesced read after work-order changes", () => {
    const detail = read("src/components/portal/pro-vendor-detail.tsx");
    expect(detail.match(/Could not load vendor history\./g)).toHaveLength(2);
    expect(detail).toContain("void refreshSummary(true)");
    expect(detail).toContain("const summaryRequest = useRef(0)");
    expect(detail).toContain("if (summaryRequest.current !== request) return");
    expect(detail).toContain('data-attr="vendor-job-open"');
    expect(detail).toContain("Accepted quote {jobMoney(job.acceptedQuoteCents)} · Final invoice {jobMoney(job.finalInvoiceCents)} · Paid {jobMoney(job.paidCents)}");
  });
});

describe("resident and vendor dashboard presentation parity", () => {
  it("removes only generic resident helper copy and retains the service label and pricing disclosure", () => {
    const moveIn = read("src/components/portal/resident-move-in-view.tsx");
    const communication = read("src/components/portal/resident-communication.tsx");
    const services = read("src/components/portal/resident-services-panel.tsx");
    expect(moveIn).not.toContain("Where you are assigned and when you can move in.");
    expect(moveIn).not.toContain("Shared information from your property manager.");
    expect(moveIn).not.toContain("What this home offers.");
    expect(moveIn).not.toContain("Keys, parking, access codes, and anything to know before arrival.");
    expect(moveIn).toContain("No room instructions have been added yet.");
    expect(communication).not.toContain("conversation{merged.length === 1 ? \"\" : \"s\"}");
    expect(services).toContain('>Service</p>');
    expect(services).toContain("Pricing is set by your manager and can&apos;t be changed here.");
    expect(services).not.toContain("Update your maintenance request. Your property manager sees these changes.");
  });

  it("uses shared dashboard panels with icon utilities and factual vendor empty states", () => {
    const dashboard = read("src/components/portal/vendor-dashboard.tsx");
    expect(dashboard).not.toContain("portalDashboardWelcomeSubtitle");
    expect(dashboard).not.toContain("No jobs yet");
    expect(dashboard).not.toContain("Nothing waiting");
    expect(dashboard).not.toContain("Nothing scheduled");
    expect(dashboard).not.toContain("Needs a reply");
    expect(dashboard).not.toContain("Set up messaging in Settings");
    expect(dashboard).not.toContain("Manage services →");
    expect(dashboard).toContain("KpiCard");
    expect(dashboard).toContain("AttentionPanel");
    expect(dashboard).toContain("UpcomingPanel");
    expect(dashboard).not.toContain("VendorMetric");
    expect(dashboard).not.toContain("VendorAttentionPanel");
    expect(dashboard).not.toContain("VendorUpcomingPanel");
    expect(dashboard).toContain("No upcoming visits.");
    expect(dashboard).toContain("PortalIconAction");
    expect(dashboard).toContain('label="Manage services"');
    expect(dashboard).toContain('label="Open calendar"');

    const shared = read("src/components/portal/pro-dashboard-kpis.tsx");
    expect(shared).toContain('emptyCopy = "Nothing is waiting on you. Nice."');
    expect(shared).toContain('emptyCopy = "Nothing scheduled in the next two weeks."');
    expect(shared).toContain("hideRowDetail = false");
    expect(shared).toContain("aside ?? (");
  });
});
