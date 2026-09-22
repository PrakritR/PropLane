// @vitest-environment jsdom
// Vendor jobs (work orders), invoices, and payouts are now record pages
// (PLAN-0920-1058, area 1c): a list row navigates to its own page instead of
// expanding inline / opening a modal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  subscribeDemoPath: () => () => {},
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/work-orders",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/work-order-bids", () => ({
  fetchWorkOrderBidsResult: async () => ({ ok: true, bids: [] }),
}));
vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: async () => ({ ok: true, payouts: [PAYOUT] }),
}));
vi.mock("@/lib/work-order-vendor-offers", () => ({
  fetchWorkOrderVendorOffers: async () => [],
  declineWorkOrderVendorOffer: async () => {},
}));
vi.mock("@/lib/work-order-bids-storage", () => ({
  upsertWorkOrderBid: () => {},
  WORK_ORDER_BIDS_EVENT: "work-order-bids",
}));

const JOB = {
  id: "wo-1",
  title: "Replace water heater",
  reference: "WO-2001",
  status: "Scheduled",
  bucket: "scheduled" as const,
  propertyName: "123 Main St",
  unit: "",
  propertyId: "prop-1",
  scheduled: "Sep 25, 2026",
  scheduledAtIso: "2026-09-25T10:00:00.000Z",
  description: "Water heater is leaking, needs replacement.",
  priority: "High",
  vendorId: "vendor-1",
  biddingOpen: false,
  photoDataUrls: [] as string[],
};

const PAYOUT = {
  id: "payout-1",
  workOrderId: "wo-1",
  amountCents: 45000,
  stripeTransferId: "tr_123",
  status: "paid" as const,
  failureReason: null,
  createdAt: "2026-09-10T00:00:00.000Z",
};

vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [JOB],
  readManagerWorkOrderRows: () => [JOB],
  syncManagerWorkOrdersFromServer: async () => {},
  updateManagerWorkOrder: () => {},
}));

function stubInvoiceFetch(invoice: Record<string, unknown> | null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (url.includes("/api/vendor/invoices")) {
      return {
        ok: true,
        json: async () => ({ invoices: invoice ? [invoice] : [], linkedManagers: [] }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

const INVOICE = {
  id: "inv-1",
  vendorId: "vendor-1",
  workOrderId: "wo-1",
  invoiceNumber: "INV-1001",
  lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 20000, amountCents: 20000 }],
  subtotalCents: 20000,
  taxCents: 0,
  totalCents: 20000,
  currency: "usd",
  status: "submitted",
  memo: "Replaced the unit.",
  decisionNote: null,
  billId: null,
  submittedAt: "2026-09-10T00:00:00.000Z",
  decidedAt: null,
  paidAt: null,
};

import { VendorWorkOrdersPanel } from "@/components/portal/vendor-work-orders-panel";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";

afterEach(() => {
  cleanup();
  navigate.mockClear();
  vi.unstubAllGlobals();
});

describe("vendor job record page", () => {
  it("a row navigates to /vendor/work-orders/<id> (overview, the default tab, omitted)", async () => {
    render(
      <AppUiProvider>
        <VendorWorkOrdersPanel tabId="upcoming" />
      </AppUiProvider>,
    );
    const row = await screen.findByText("Replace water heater");
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith("/vendor/work-orders/wo-1");
  });

  it("the rail has the registry's trimmed sections (PLAN-0921-1029): Overview, Schedule, Invoice, Communication", async () => {
    render(
      <AppUiProvider>
        <VendorWorkOrdersPanel tabId="upcoming" workOrderId="wo-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("Replace water heater");

    const rail = screen.getByRole("navigation", { name: "Job sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Schedule",
      "Invoice",
      "Communication",
    ]);

    // Header icon labels — queried by data-attr since "Accept" is also the
    // phone sticky primary's own button (jsdom renders both, unlike a real
    // browser where the desktop icon row is `hidden` below `lg`).
    expect(document.querySelector('[data-attr="record-header-action-accept"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-schedule"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-submit-invoice"]')).not.toBeNull();
  });
});

describe("vendor invoice record page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubInvoiceFetch(INVOICE));
  });

  it("a row navigates to /vendor/financials/invoices/<id> (overview, the default tab, omitted)", async () => {
    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="invoices" />
      </AppUiProvider>,
    );
    const row = await screen.findByText("INV-1001");
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith("/vendor/financials/invoices/inv-1");
  });

  it("the rail has Overview, Lines, Payout, Communication, Documents and the header icons match the registry", async () => {
    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="invoices" recordId="inv-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("INV-1001");

    const rail = screen.getByRole("navigation", { name: "Invoice sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Lines", "Payout", "Communication", "Documents"]);

    expect(document.querySelector('[data-attr="record-header-action-edit"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-withdraw"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-download"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-submit"]')).not.toBeNull();
  });
});

describe("vendor payout record page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubInvoiceFetch(null));
  });

  it("the rail has Overview, Included invoices, Communication and the header icons match the registry", async () => {
    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="payouts" recordId="payout-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("Replace water heater");

    const rail = screen.getByRole("navigation", { name: "Payout sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Included invoices", "Communication"]);

    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});
