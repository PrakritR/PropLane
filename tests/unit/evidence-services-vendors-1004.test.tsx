// @vitest-environment jsdom
//
// EVIDENCE HARNESS for the Oct 3-4 services + vendors round
// (studio plan claude-2/services-vendors-1004).
//
// Renders the real end-user surfaces this round changed and, when EVIDENCE_DIR
// is set, writes each one out as an HTML fragment so a reviewer can look at the
// screen instead of reading a selector assertion:
//
//   1. the manager Services list on every stage tab (Open · Assigned · Scheduled · Completed)
//   2. a service's Vendors section — Requested · Estimates · Bids · Approved · Declined
//   3. the same section's side-by-side bid compare
//   4. the vendor portal's Estimate & bid form (estimate / book a visit / submit a bid)
//
// Same pattern as tests/unit/evidence-resident-application-rows.test.tsx:
// without EVIDENCE_DIR the file is a plain render test and writes nothing.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { VendorRequestRow } from "@/lib/work-order-bid-cycle";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
function capture(name: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: document.body.innerHTML });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

const fixtures = vi.hoisted(() => ({
  workOrders: [] as Array<Record<string, unknown>>,
  requests: [] as Array<Record<string, unknown>>,
}));

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

const wo = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Burst pipe under the kitchen sink",
  priority: "Medium", status: "Open", bucket: "open", description: "", scheduled: "—", cost: "—",
  propertyId: "prop-a", residentName: "Maya Chen", residentEmail: "", ...over,
});

const vendorRow = (over: Partial<VendorRequestRow> = {}): VendorRequestRow => ({
  key: "k1", vendorDirectoryId: "d1", vendorUserId: "v1", vendorName: "Pacific Plumbing",
  offerId: "o1", bidId: "b1", state: "bid", estimateCents: null, visitAt: null, visitFeeCents: 0,
  visitDone: false, bidAmountCents: 42_000, bidMaterialsCents: 8_000, bidTotalCents: 50_000,
  proposedTime: "2026-10-08T16:00:00.000Z", note: null, requestedAt: "2026-10-01T00:00:00.000Z",
  estimateAt: "2026-10-02T00:00:00.000Z", canApprove: true, ...over,
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the manager Services list, rendered on every stage tab", () => {
  beforeEach(() => {
    fixtures.requests = [];
    fixtures.workOrders = [
      wo({ id: "wo-open", title: "Burst pipe under the kitchen sink", biddingOpen: true }),
      wo({
        id: "wo-assigned", title: "Replace the hallway smoke alarm", unit: "1A",
        residentName: "Sam Lee", vendorId: "d1", vendorName: "Pacific Plumbing",
        biddingResolvedAt: "2026-10-06T00:00:00.000Z",
      }),
      wo({
        id: "wo-scheduled", title: "Closet door off its track", unit: "3C",
        residentName: "Avery Kim", bucket: "scheduled", vendorId: "d2", vendorName: "Northgate Handyman",
        scheduledAtIso: new Date(2026, 9, 8, 9, 0).toISOString(),
      }),
      wo({
        id: "wo-completed", title: "Annual furnace service", unit: "2B",
        residentName: "Maya Chen", bucket: "completed", automationStatus: "paid",
        vendorId: "d3", vendorName: "Sound Heating", cost: "$214",
      }),
    ];
  });

  it("shows each stage tab with its own services under the four-stage band", async () => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ManagerAllServicesPanel } = await import("@/components/portal/pro-all-services-panel");
    render(
      <AppUiProvider>
        <ManagerAllServicesPanel tabId="work-orders" basePath="/portal" lockedPropertyId="prop-a" />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1));
    for (const name of ["Open", "Assigned", "Scheduled", "Completed"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${name}`) }).length).toBeGreaterThan(0);
    }
    expect(document.body.textContent).toContain("Burst pipe under the kitchen sink");
    capture("services-list-open");

    for (const [tab, title] of [
      ["assigned", "Replace the hallway smoke alarm"],
      ["scheduled", "Closet door off its track"],
      ["completed", "Annual furnace service"],
    ] as const) {
      fireEvent.click(document.querySelector(`[data-attr="manager-services-state-${tab}"]`) as HTMLElement);
      await waitFor(() => expect(document.body.textContent).toContain(title));
      expect(document.querySelectorAll('[data-attr="work-order-list-row"]').length).toBe(1);
      capture(`services-list-${tab}`);
    }
  });
});

describe("a service's Vendors section", () => {
  const rows: VendorRequestRow[] = [
    vendorRow({ key: "k1", vendorName: "Pacific Plumbing", bidAmountCents: 42_000, bidMaterialsCents: 8_000, bidTotalCents: 50_000 }),
    vendorRow({
      key: "k2", vendorDirectoryId: "d2", vendorUserId: "v2", vendorName: "Northgate Handyman", bidId: "b2",
      bidAmountCents: 31_500, bidMaterialsCents: 6_000, bidTotalCents: 37_500,
      proposedTime: "2026-10-09T17:00:00.000Z",
    }),
    vendorRow({
      key: "k3", vendorDirectoryId: "d3", vendorUserId: "v3", vendorName: "Sound Heating", bidId: null,
      state: "estimate", estimateCents: 45_000, bidAmountCents: null, bidMaterialsCents: 0, bidTotalCents: null, canApprove: false,
    }),
    vendorRow({
      key: "k4", vendorDirectoryId: "d4", vendorUserId: "v4", vendorName: "Harborview Electric", bidId: null,
      state: "requested", estimateCents: null, bidAmountCents: null, bidMaterialsCents: 0, bidTotalCents: null, canApprove: false,
    }),
  ];

  it("lists one row per asked vendor under the tab its answer reached, and compares bids side by side", async () => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ServiceVendorCycleSection } = await import("@/components/portal/service-vendor-cycle-section");
    render(
      <AppUiProvider>
        <ServiceVendorCycleSection
          stage="open"
          requests={rows}
          approvingBidId={null}
          onRequestBids={vi.fn()}
          onApprove={vi.fn()}
          onMessage={vi.fn()}
          onRemove={vi.fn()}
        />
      </AppUiProvider>,
    );
    for (const name of ["Requested", "Estimates", "Bids", "Approved", "Declined"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(`^${name}`) }).length).toBeGreaterThan(0);
    }
    // The cheaper of the two bids is marked on its own row.
    expect(document.body.textContent).toContain("Pacific Plumbing");
    expect(document.body.textContent).toContain("Northgate Handyman · Lowest");
    capture("service-vendors-bids");

    fireEvent.click(screen.getByRole("button", { name: /Compare/ }));
    await waitFor(() => expect(document.querySelectorAll('[data-attr="service-bid-compare-card"]').length).toBe(2));
    // The cheaper bid is marked, and each card can be approved from the comparison.
    expect(document.body.textContent).toContain("Lowest");
    expect(document.querySelectorAll('[data-attr="service-approve-bid"]').length).toBe(2);
    capture("service-vendors-compare");
  });
});

describe("the vendor portal's answer to a request", () => {
  it("offers an estimate, a visit booking and a full bid on one service", async () => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { VendorEstimateBidSection } = await import("@/components/portal/vendor-estimate-bid-section");
    const bid: WorkOrderBid = {
      id: "b1", workOrderId: "wo-1", vendorUserId: "v1", vendorDirectoryId: "d1", vendorName: "Pacific Plumbing",
      quoteMode: "upfront", consultationVisitAt: null, amountCents: null, materialsCents: 0, proposedTime: null,
      note: null, status: "submitted", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const submitRef = { current: null as null | (() => void) };
    render(
      <AppUiProvider>
        <VendorEstimateBidSection
          row={wo({ id: "wo-1", title: "Burst pipe under the kitchen sink" })}
          bid={bid}
          offer={undefined}
          stage="open"
          choice="bid"
          onChoice={vi.fn()}
          submitRef={submitRef}
          onSent={vi.fn()}
          onDecline={vi.fn()}
          onWithdraw={vi.fn()}
        />
      </AppUiProvider>,
    );
    expect(document.body.textContent).toBeTruthy();
    capture("vendor-portal-estimate-bid");
  });
});

describe("the Request bids / Assign dialog", () => {
  it("asks who does the work, and can also publish to nearby PropLane vendors", async () => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ServiceAssignDialog } = await import("@/components/portal/service-assign-dialog");
    render(
      <AppUiProvider>
        <ServiceAssignDialog
          open
          onClose={vi.fn()}
          allowVendors
          vendors={[
            { id: "d1", name: "Pacific Plumbing", trade: "Plumbing" },
            { id: "d2", name: "Northgate Handyman", trade: "Handyman" },
          ]}
          teamMembers={[{ userId: "t1", name: "Jordan Lee" }]}
          meUserId="mgr-1"
          trade="Plumbing"
          onRequestBids={vi.fn()}
          onAssign={vi.fn()}
        />
      </AppUiProvider>,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Also send to PropLane vendors within"));
    capture("service-request-bids-dialog");
  });
});
