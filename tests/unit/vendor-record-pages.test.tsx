// @vitest-environment jsdom
// Vendor jobs (work orders), invoices, and payouts are now record pages
// (PLAN-0920-1058, area 1c): a list row navigates to its own page instead of
// expanding inline / opening a modal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
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
  it("a row navigates to /vendor/work-orders/<id> (Service, the default section, omitted)", async () => {
    render(
      <AppUiProvider>
        <VendorWorkOrdersPanel tabId="scheduled" />
      </AppUiProvider>,
    );
    const row = await screen.findByText("Replace water heater");
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith("/vendor/work-orders/wo-1");
  });

  it("the rail is Job, Money and Records, with one primary next step", async () => {
    render(
      <AppUiProvider>
        <VendorWorkOrdersPanel tabId="scheduled" workOrderId="wo-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("Replace water heater");

    const rail = screen.getByRole("navigation", { name: "Service sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Estimate & bid",
      "Schedule",
      "Invoice",
      "Payments",
      "Communication",
      "Documents",
    ]);

    // A scheduled job's one primary is Complete; Message is the only other icon.
    const primary = document.querySelector('[data-attr="vendor-job-primary"]');
    expect(primary?.getAttribute("aria-label") ?? primary?.textContent).toContain("Complete");
    expect(document.querySelectorAll('[data-attr="vendor-job-primary"]').length).toBe(1);
    expect(document.querySelector('[data-attr="vendor-job-message"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-accept"]')).toBeNull();
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

  it("the rail has Overview, Included invoices, Communication, and no Receipt/Refund header action while VENDOR_BANKING_ENABLED is off", async () => {
    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="payouts" recordId="payout-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("Replace water heater");

    const rail = screen.getByRole("navigation", { name: "Payout sections" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Included invoices", "Communication"]);

    // VD52/VD53's Receipt/Refund header actions are part of the new
    // vendor-banking UI (`VendorPayoutRecordPage`'s `vendorBankingOn` gate,
    // signaled by `feeBps` on the balance snapshot) — this test's fetch stub
    // answers every non-invoice URL with `{}`, so `feeBps` is absent and
    // neither action renders, matching flag-off byte-for-byte.
    expect(screen.queryByRole("button", { name: "Receipt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });

  it("shows Receipt (never Refund — the vendor refund route is paused) once VENDOR_BANKING_ENABLED is on, and Receipt opens the print route (never a Stripe redirect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        if (url.includes("/api/vendor/invoices")) return { ok: true, json: async () => ({ invoices: [], linkedManagers: [] }) } as unknown as Response;
        if (url.includes("/api/vendor/payouts/balance")) {
          return { ok: true, json: async () => ({ feeBps: 300, setup: { ready: true }, history: [] }) } as unknown as Response;
        }
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="payouts" recordId="payout-1" />
      </AppUiProvider>,
    );
    await screen.findAllByText("Replace water heater");

    await screen.findByRole("button", { name: "Receipt" });
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();

    // The Receipt button appears as soon as `feeBps` lands, but the payout row it
    // prints is still resolving; clicking on that first paint did nothing and made
    // this assertion fail under a loaded full-suite run. Retry until the row is in.
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
      expect(openSpy).toHaveBeenCalledWith("/print/vendor-payout/payout-1", "_blank", "noopener");
    });
  });
});
