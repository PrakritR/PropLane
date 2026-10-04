// @vitest-environment jsdom
//
// The Services list follows the bid cycle: Open / Scheduled / Done only (no Vendors tab), each
// service in the tab its stage says, the SAME list embedded in a property record scoped to that
// property, and rows that carry no pill.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { serviceListBucket, serviceListStageFact } from "@/lib/work-order-bid-cycle";
import { buildUnifiedServiceRows, countServiceRowsByState } from "@/lib/unified-service-rows";
import { managerServiceRowMenuItems } from "@/lib/manager-service-row-menu";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const wo = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Burst pipe", priority: "Medium", status: "Open", bucket: "open",
  description: "", scheduled: "—", cost: "—", propertyId: "prop-a", residentName: "Maya Chen", residentEmail: "", ...over,
});
const bid = (over: Partial<WorkOrderBid> = {}): WorkOrderBid => ({
  id: "b1", workOrderId: "wo-1", vendorUserId: "v1", vendorDirectoryId: "d1", vendorName: "Pacific", quoteMode: "upfront", consultationVisitAt: null,
  amountCents: null, materialsCents: 0, proposedTime: null, note: null, status: "submitted", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
});
const offer = (over: Partial<WorkOrderVendorOffer> = {}): WorkOrderVendorOffer => ({
  id: "o1", workOrderId: "wo-1", vendorDirectoryId: "d1", vendorUserId: null, status: "sent", createdAt: "2026-10-01T00:00:00.000Z", ...over,
});

describe("which Services tab a service sits in (the stage function)", () => {
  const none = { bids: [], offers: [] };
  it("Open = pending and bids requested", () => {
    expect(serviceListBucket(wo(), none)).toBe("open");
    expect(serviceListBucket(wo({ biddingOpen: true }), { bids: [], offers: [offer()] })).toBe("open");
  });
  it("Scheduled = bid approved or assigned and scheduled", () => {
    const hired = { vendorId: "d1", vendorName: "Pacific", biddingResolvedAt: "2026-10-06T00:00:00.000Z" };
    expect(serviceListBucket(wo({ ...hired }), { bids: [bid({ status: "accepted", amountCents: 1 })], offers: [] })).toBe("scheduled");
    expect(serviceListBucket(wo({ bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("scheduled");
  });
  it("Done = completed and paid", () => {
    expect(serviceListBucket(wo({ bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("done");
    expect(serviceListBucket(wo({ bucket: "scheduled", automationStatus: "vendor_marked_done", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("done");
  });
  it("counts per tab come from the same function (unified rows carry the derived state)", () => {
    const rows = buildUnifiedServiceRows({
      addOns: [],
      maintenance: [
        { ...wo({ id: "a" }), state: serviceListBucket(wo({ id: "a" }), none) },
        { ...wo({ id: "b", bucket: "scheduled", vendorId: "d1", vendorName: "P", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), state: "scheduled" as const },
        { ...wo({ id: "c", bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "P" }), state: "done" as const },
      ],
    });
    expect(countServiceRowsByState(rows)).toEqual({ open: 1, scheduled: 1, done: 1, declined: 0 });
  });
});

describe("the stage fact on a row", () => {
  it("reads 3 bids / Visit … / Scheduled … / Completed / Paid / Pending", () => {
    const bids = ["a", "b", "c"].map((id) => bid({ id, vendorUserId: id, vendorDirectoryId: `d-${id}`, amountCents: 10000, bidSubmittedAt: "2026-10-02T00:00:00.000Z" }));
    expect(serviceListStageFact(wo({ biddingOpen: true }), { bids, offers: [] })).toBe("3 bids");
    expect(serviceListStageFact(wo(), { bids: [], offers: [] })).toBe("Pending");
    expect(serviceListStageFact(wo({ biddingOpen: true }), { bids: [], offers: [offer(), offer({ id: "o2", vendorDirectoryId: "d2" })] })).toBe("Bids requested · 2");
    expect(serviceListStageFact(wo({ biddingOpen: true }), { bids: [bid({ quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z" })], offers: [] })).toMatch(/^Visit /);
    expect(serviceListStageFact(wo({ bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z", vendorId: "d1", vendorName: "P" }), { bids: [], offers: [] })).toMatch(/^Scheduled /);
    expect(serviceListStageFact(wo({ bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "P" }), { bids: [], offers: [] })).toBe("Paid");
  });
  it("the row menu offers Request bids, Assign, Message and Delete", () => {
    const labels = managerServiceRowMenuItems(wo(), { communicationHref: "/x" }).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Request bids", "Assign", "Message", "Delete"]));
    expect(labels).not.toContain("Cancel service");
  });
});

describe("the Services page has no Vendors tab", () => {
  it("lists exactly Open, Scheduled, Done", async () => {
    const mod = await import("@/components/portal/pro-all-services-panel");
    expect(mod.SERVICE_STATE_TABS.map((t) => t.label)).toEqual(["Open", "Scheduled", "Done"]);
  });
  it("no longer renders the Vendors tab body", () => {
    const src = read("src/components/portal/pro-all-services-panel.tsx");
    expect(src).not.toContain("ManagerServicesVendorsTab");
    expect(src).not.toMatch(/"vendors"/);
  });
});

describe("the property record's Services tab is the same list", () => {
  it("renders ManagerAllServicesPanel scoped to the property, with the catalog behind the settings icon", () => {
    const tab = read("src/components/portal/property-services-tab.tsx");
    expect(tab).toMatch(/<ManagerAllServicesPanel[\s\S]*lockedPropertyId=\{propertyId\}/);
    const house = read("src/components/portal/pro-house-properties-panel.tsx");
    expect(house).toContain("<PropertyServicesTab");
    expect(house).not.toContain("<PropertyServicesOffersPanel");
  });
});

// ---- the embedded list, rendered ----
const fixtures = vi.hoisted(() => ({ workOrders: [] as Array<Record<string, unknown>>, requests: [] as Array<Record<string, unknown>> }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/all/prop-a/requests",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", ready: true }) }));
vi.mock("@/lib/manager-work-orders-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readManagerWorkOrderRows: () => fixtures.workOrders,
  syncManagerWorkOrdersFromServer: async () => fixtures.workOrders,
}));
vi.mock("@/lib/service-requests-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAllServiceRequests: () => fixtures.requests,
  syncServiceRequestsFromServer: async () => fixtures.requests,
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moduleRowVisibleToPortalUser: () => true,
}));

describe("embedded Services list (property record)", () => {
  beforeEach(() => {
    fixtures.workOrders = [
      wo({ id: "wo-a", title: "Burst pipe", propertyId: "prop-a" }),
      wo({ id: "wo-b", title: "Broken gate", propertyId: "prop-b", propertyName: "Birch House", residentName: "Sam Lee" }),
    ];
    fixtures.requests = [];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows only this property's services, with Open / Scheduled / Done and no Vendors tab or property filter chip", async () => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ManagerAllServicesPanel } = await import("@/components/portal/pro-all-services-panel");
    render(
      <AppUiProvider>
        <ManagerAllServicesPanel tabId="work-orders" basePath="/portal" lockedPropertyId="prop-a" />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1));
    expect(document.body.textContent).toContain("Maya Chen");
    expect(document.body.textContent).not.toContain("Sam Lee");
    expect(screen.queryByRole("button", { name: /^Vendors/ })).toBeNull();
    for (const label of ["Open", "Scheduled", "Done"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${label}`) }).length).toBeGreaterThan(0);
    }
    // The embedded list is not the page: no page title shell.
    expect(document.querySelector('[data-svc-page]')).not.toBeNull();
  });
});
