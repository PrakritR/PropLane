// @vitest-environment jsdom
//
// The Services URL names the tab: /services/work-orders/scheduled selects Scheduled (not Open), a tab
// click writes the URL back, and the add-on request record shows the same Vendor & schedule cycle UI
// as a maintenance service. The Service tab carries no subtext.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_TAB_URL_SEGMENT, serviceTabFromSegment } from "@/lib/unified-service-rows";
import { deriveAddOnStages } from "@/lib/work-order-bid-cycle";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const state = vi.hoisted(() => ({
  pathname: "/portal/services/work-orders/scheduled",
  workOrders: [] as Array<Record<string, unknown>>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", ready: true }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [{ userId: "mgr-1", name: "Test Manager" }, { userId: "co-1", name: "Casey Co" }], vendors: [] }),
}));
vi.mock("@/lib/manager-work-orders-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readManagerWorkOrderRows: () => state.workOrders,
  syncManagerWorkOrdersFromServer: async () => state.workOrders,
}));
vi.mock("@/lib/service-requests-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAllServiceRequests: () => state.requests,
  syncServiceRequestsFromServer: async () => state.requests,
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moduleRowVisibleToPortalUser: () => true,
}));
vi.mock("@/components/portal/record-communication-section", () => ({ RecordCommunicationSection: () => <div /> }));

const wo = (over: Record<string, unknown>) => ({
  id: "wo-x", propertyName: "Alder House", unit: "2B", title: "Burst pipe", priority: "Medium", status: "Open", bucket: "open",
  description: "", scheduled: "—", cost: "—", residentName: "Maya Chen", residentEmail: "", propertyId: "prop-a", ...over,
});

beforeEach(() => {
  state.pathname = "/portal/services/work-orders/scheduled";
  state.workOrders = [
    wo({ id: "wo-open", title: "Open pipe" }),
    wo({ id: "wo-sched", title: "Scheduled gate", bucket: "scheduled", status: "Scheduled", vendorId: "d1", vendorName: "Pacific", scheduledAtIso: "2026-10-08T16:00:00.000Z" }),
    wo({ id: "wo-done", title: "Done faucet", bucket: "completed", status: "Completed", vendorId: "d1", vendorName: "Pacific", automationStatus: "paid" }),
  ];
  state.requests = [
    {
      id: "seed-sr-storage-AXIS-DEMOLIAMF", offerId: "o", offerName: "Storage locker", offerDescription: "Basement locker", price: "$40 / month", deposit: "$50",
      residentEmail: "", residentName: "Liam Foster", managerUserId: "mgr-1", propertyId: "prop-a", returnByDate: "", notes: "",
      requestedAt: "2026-10-02T00:00:00.000Z", status: "pending", servicePaid: false, depositPaid: false,
    },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderPanel = async (props: Record<string, unknown>) => {
  const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
  const { ManagerAllServicesPanel } = await import("@/components/portal/pro-all-services-panel");
  return render(
    <AppUiProvider>
      <ManagerAllServicesPanel basePath="/portal" tabId="work-orders" {...props} />
    </AppUiProvider>,
  );
};

const activeTabLabel = () => document.querySelector('[aria-label="Service status"] [aria-current="page"]')?.textContent ?? "";

describe("the URL tab segment selects the Services tab", () => {
  it("maps the segment to a tab and back", () => {
    expect(serviceTabFromSegment("open")).toBe("open");
    expect(serviceTabFromSegment("scheduled")).toBe("scheduled");
    expect(serviceTabFromSegment("completed")).toBe("done");
    expect(serviceTabFromSegment("done")).toBe("done");
    expect(serviceTabFromSegment("some-record-id")).toBeNull();
    expect(serviceTabFromSegment(undefined)).toBeNull();
    expect(SERVICE_TAB_URL_SEGMENT).toMatchObject({ open: "open", scheduled: "scheduled", done: "completed" });
  });

  it("/services/work-orders/scheduled shows the Scheduled tab and its rows, not Open", async () => {
    await renderPanel({ workOrderBucket: "scheduled" });
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1));
    expect(activeTabLabel()).toMatch(/^Scheduled/);
    expect(document.body.textContent).toContain("Scheduled gate");
    expect(document.body.textContent).not.toContain("Open pipe");
  });

  it("/services/work-orders/completed shows Done", async () => {
    state.pathname = "/portal/services/work-orders/completed";
    await renderPanel({ workOrderBucket: "completed" });
    await waitFor(() => expect(document.body.textContent).toContain("Done faucet"));
    expect(activeTabLabel()).toMatch(/^Done/);
  });

  it("clicking a tab updates the URL", async () => {
    await renderPanel({ workOrderBucket: "scheduled" });
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1));
    const push = vi.spyOn(window.history, "pushState");
    fireEvent.click(screen.getAllByRole("button", { name: /^Done/ })[0]!);
    await waitFor(() => expect(activeTabLabel()).toMatch(/^Done/));
    expect(push).toHaveBeenCalledWith(null, "", "/portal/services/work-orders/completed");
    fireEvent.click(screen.getAllByRole("button", { name: /^Open/ })[0]!);
    expect(push).toHaveBeenCalledWith(null, "", "/portal/services/work-orders/open");
  });

  it("an embedded (property) list never writes the URL", async () => {
    await renderPanel({ workOrderBucket: "scheduled", lockedPropertyId: "prop-a" });
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBeGreaterThan(0));
    const push = vi.spyOn(window.history, "pushState");
    fireEvent.click(screen.getAllByRole("button", { name: /^Done/ })[0]!);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("add-on request: Vendor & schedule renders the cycle UI", () => {
  const renderRequest = (tab: string) =>
    renderPanel({
      tabId: "requests",
      requestBucket: "pending",
      serviceRequestId: "seed-sr-storage-AXIS-DEMOLIAMF",
      serviceDetailTab: tab,
    });

  it("shows the stage bar, the Assign dropdown (Myself / teammates) and no old empty cards", async () => {
    await renderRequest("vendor-schedule");
    await waitFor(() => expect(document.querySelector('[data-attr="service-vendor-cycle"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="service-stage-bar"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/Pending/);
    expect(document.querySelector('[data-attr="service-assign-select"]')).not.toBeNull();
    // Vendors cannot take add-on services, so there is nobody to request bids from: no +.
    expect(document.querySelector('[data-attr="service-request-more-vendors"]')).toBeNull();
    expect(document.body.textContent).not.toContain("No vendor for this service");
    expect(document.body.textContent).not.toContain("Not scheduled yet");
    // The empty list is exactly one standard card.
    expect(document.querySelectorAll('[data-attr="service-vendor-requests-empty"]')).toHaveLength(1);
  });

  it("derives the add-on stage bar from the request's own status", () => {
    expect(deriveAddOnStages("pending").map((s) => `${s.id}:${s.state}`)).toEqual(["pending:current", "approved:todo", "completed:todo"]);
    expect(deriveAddOnStages("approved").map((s) => s.state)).toEqual(["done", "current", "todo"]);
    expect(deriveAddOnStages("returned").map((s) => s.state)).toEqual(["done", "done", "current"]);
    expect(deriveAddOnStages("denied").map((s) => s.id)).toEqual(["pending", "declined"]);
  });

  it("the Service tab shows 'Not assigned' as a plain value with no second line, and a Needs-you row with no muted line", async () => {
    await renderRequest("service");
    await waitFor(() => expect(document.querySelector('[data-attr="record-overview-needs-assign-vendor"]')).not.toBeNull());
    const vendorTile = [...document.querySelectorAll("[data-attr^='record-overview-tile']")].find((el) => /Vendor/.test(el.textContent ?? ""));
    expect(vendorTile?.textContent).toContain("Not assigned");
    expect(vendorTile?.innerHTML).not.toMatch(/text-\[var\(--status-overdue-fg\)\]/);
    expect(document.body.textContent).not.toContain("No vendor assigned yet");
    const needs = document.querySelector('[data-attr="record-overview-needs-assign-vendor"]')!;
    expect(needs.textContent).toBe("Assign a vendor");
    expect(needs.querySelector("button")).not.toBeNull();
  });
});

describe("no subtext on the Service tab", () => {
  it("the maintenance Service tab passes no detail line on its tiles or Needs-you rows", () => {
    const src = read("src/components/portal/pro-work-orders-panel.tsx");
    const a = src.indexOf("overviewTiles: [");
    const b = src.indexOf("overviewCards: [", a);
    const block = src.slice(a, b);
    expect(block).not.toMatch(/detail:/);
    expect(block).not.toContain('tone: "danger"');
    const all = read("src/components/portal/pro-all-services-panel.tsx");
    const a2 = all.indexOf("overviewTiles: [", all.indexOf('activeTab === "communication"'));
    const block2 = all.slice(a2, all.indexOf("overviewCards: [", a2));
    expect(block2).not.toMatch(/detail:/);
    expect(block2).not.toContain('tone: "danger"');
  });
});
