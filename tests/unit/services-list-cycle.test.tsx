// @vitest-environment jsdom
//
// The Services list follows the lifecycle: Open / Assigned / Scheduled / Completed only (no Vendors tab), each
// service in the tab its stage says, the SAME list embedded in a property record scoped to that
// property, and rows that carry no pill.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { workOrderServiceStage, workOrderStageFact } from "@/lib/service-lifecycle";
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
  it("Open = new, or out for bids", () => {
    expect(workOrderServiceStage(wo(), none)).toBe("open");
    expect(workOrderServiceStage(wo({ biddingOpen: true }), { bids: [], offers: [offer()] })).toBe("open");
    expect(workOrderServiceStage(wo({ biddingOpen: true }), { bids: [bid({ amountCents: 1, bidSubmittedAt: "2026-10-02T00:00:00.000Z" })], offers: [] })).toBe("open");
  });
  it("Assigned = a bid approved, or someone picked, with no time yet", () => {
    const hired = { vendorId: "d1", vendorName: "Pacific", biddingResolvedAt: "2026-10-06T00:00:00.000Z" };
    expect(workOrderServiceStage(wo({ ...hired }), { bids: [bid({ status: "accepted", amountCents: 1 })], offers: [] })).toBe("assigned");
    expect(workOrderServiceStage(wo({ selfAssigned: true, assignee: { type: "team", id: "m", name: "You" } }), none)).toBe("assigned");
  });
  it("Scheduled = has a visit time", () => {
    expect(workOrderServiceStage(wo({ bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("scheduled");
  });
  it("Completed = completed, vendor-marked-done and paid", () => {
    expect(workOrderServiceStage(wo({ bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("completed");
    expect(workOrderServiceStage(wo({ bucket: "scheduled", automationStatus: "vendor_marked_done", vendorId: "d1", vendorName: "Pacific" }), none)).toBe("completed");
  });
  it("counts per tab come from the same function (unified rows carry the derived state)", () => {
    const rows = buildUnifiedServiceRows({
      addOns: [],
      maintenance: [
        { ...wo({ id: "a" }), state: workOrderServiceStage(wo({ id: "a" }), none) },
        { ...wo({ id: "a2", vendorId: "d1", vendorName: "P" }), state: workOrderServiceStage(wo({ id: "a2", vendorId: "d1", vendorName: "P" }), none) },
        { ...wo({ id: "b", bucket: "scheduled", vendorId: "d1", vendorName: "P", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), state: "scheduled" as const },
        { ...wo({ id: "c", bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "P" }), state: "completed" as const },
      ],
    });
    expect(countServiceRowsByState(rows)).toEqual({ open: 1, assigned: 1, scheduled: 1, completed: 1, declined: 0 });
  });
});

describe("the stage fact on a row", () => {
  it("Open: N bids · lowest $X / N estimates / Requested N vendors / New", () => {
    const bids = [["a", 15_200], ["b", 20_000], ["c", 18_000]].map(([id, cents]) => bid({ id: id as string, vendorUserId: id as string, vendorDirectoryId: `d-${id}`, amountCents: cents as number, bidSubmittedAt: "2026-10-02T00:00:00.000Z" }));
    expect(workOrderStageFact(wo({ biddingOpen: true }), { bids, offers: [] })).toBe("3 bids · lowest $152");
    expect(workOrderStageFact(wo({ biddingOpen: true }), { bids: [bid({ estimateCents: 18_000 }), bid({ id: "b2", vendorUserId: "v2", vendorDirectoryId: "d2", estimateCents: 9_000 })], offers: [] })).toBe("2 estimates");
    expect(workOrderStageFact(wo({ biddingOpen: true }), { bids: [], offers: [offer(), offer({ id: "o2", vendorDirectoryId: "d2" })] })).toBe("Requested 2 vendors");
    expect(workOrderStageFact(wo(), { bids: [], offers: [] })).toBe("New");
  });
  it("Assigned: <assignee> · no time yet", () => {
    expect(workOrderStageFact(wo({ vendorId: "d1", vendorName: "Rapid Pipes" }), { bids: [], offers: [] })).toBe("Rapid Pipes · no time yet");
  });
  it("Scheduled: Thu, Oct 8 · 9am · <assignee>", () => {
    // The fact is stamped in Pacific (`service-time-labels.ts`), so the instant has to be a
    // fixed UTC one — 9am PDT — not `new Date(2026, 9, 8, 9, 0)`, which is 9am in whatever zone
    // the runner happens to be in and prints "2am" on a UTC machine like CI.
    const iso = "2026-10-08T16:00:00.000Z";
    expect(workOrderStageFact(wo({ bucket: "scheduled", scheduledAtIso: iso, vendorId: "d1", vendorName: "Rapid Pipes" }), { bids: [], offers: [] })).toBe("Thu, Oct 8 · 9am · Rapid Pipes");
  });
  it("Completed: To pay / Paid / <assignee>", () => {
    expect(workOrderStageFact(wo({ bucket: "completed", vendorId: "d1", vendorName: "P" }), { bids: [], offers: [] })).toBe("To pay");
    expect(workOrderStageFact(wo({ bucket: "completed", automationStatus: "paid", vendorId: "d1", vendorName: "P" }), { bids: [], offers: [] })).toBe("Paid");
    expect(workOrderStageFact(wo({ bucket: "completed", selfAssigned: true, assignee: { type: "team", id: "m", name: "Jordan Lee" } }), { bids: [], offers: [] })).toBe("Jordan Lee");
  });
  it("the row menu offers Request bids, Assign, Message and Delete", () => {
    const labels = managerServiceRowMenuItems(wo(), { communicationHref: "/x" }).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Request bids", "Assign", "Message", "Delete"]));
    expect(labels).not.toContain("Cancel service");
  });
});

describe("the Services page has no Vendors tab", () => {
  it("lists exactly Open, Assigned, Scheduled, Completed", async () => {
    const mod = await import("@/components/portal/pro-all-services-panel");
    expect(mod.SERVICE_STATE_TABS.map((t) => t.label)).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
  });
  it("no longer renders the Vendors tab body", () => {
    const src = read("src/components/portal/pro-all-services-panel.tsx");
    expect(src).not.toContain("ManagerServicesVendorsTab");
    expect(src).not.toMatch(/id: "vendors"/);
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

  it("shows only this property's services, with Open / Assigned / Scheduled / Completed and no Vendors tab or property filter chip", async () => {
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
    for (const label of ["Open", "Assigned", "Scheduled", "Completed"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${label}`) }).length).toBeGreaterThan(0);
    }
    // The embedded list is not the page: no page title shell.
    expect(document.querySelector('[data-svc-page]')).not.toBeNull();
  });

  it("a row reads: the service is the title, property is hidden on a property's own list, the resident and stage are facts, no pill", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fixtures.workOrders = [
      wo({ id: "wo-a", title: "Kitchen faucet drip", propertyId: "prop-a", propertyName: "The Pioneer", unit: "Room 8B", residentName: "Liam Foster", createdAtIso: "2026-09-25T18:00:00.000Z", photoDataUrls: ["data:image/png;base64,AAAA"] } as Partial<DemoManagerWorkOrderRow>),
    ];
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ManagerAllServicesPanel } = await import("@/components/portal/pro-all-services-panel");
    render(
      <AppUiProvider>
        <ManagerAllServicesPanel tabId="work-orders" basePath="/portal" lockedPropertyId="prop-a" />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1));
    const row = document.querySelector(".portal-property-row")!;
    expect(row.querySelector("p")?.textContent).toBe("Kitchen faucet drip");
    expect(row.textContent).toContain("Room 8B");
    const facts = row.querySelector('[data-attr="record-row-facts"]')!;
    expect(facts.textContent).toContain("Liam Foster");
    expect(facts.textContent).toMatch(/Requested /);
    // First photo in the tile; the row is flush inside the joined card (no card chrome of its own).
    expect(row.querySelector('[data-slot="portal-row-photo-tile"] img')?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(row.className).not.toContain("mb-3");
    // No dev-overlay console errors (duplicate or missing keys, nested buttons, band contract).
    expect(errors.mock.calls.map((c) => String(c[0]).slice(0, 300))).toEqual([]);
    errors.mockRestore();
  });
});
