// @vitest-environment jsdom
/**
 * Bug fix: a PAID invoice whose money arrived through vendor banking (a
 * `vendor_payouts` row with `invoice_id` set to that invoice — VD39-59's
 * "Request payment" rail) must open the same banking payment detail
 * (breakdown, timeline, Receipt, Refund) that an income row's payout already
 * gets. Before this fix, `VendorPaymentsTable`'s row link always sent an
 * invoice-kind row to the plain invoice detail page
 * (`vendorInvoiceDetailHref`), which has no Receipt/Refund action — the
 * vendor never saw them for the common invoice-paid case.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/financials/income",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/work-order-bids", () => ({
  fetchWorkOrderBidsResult: async () => ({ ok: true, bids: [] }),
}));
vi.mock("@/lib/work-order-vendor-offers", () => ({
  fetchWorkOrderVendorOffers: async () => [],
  declineWorkOrderVendorOffer: async () => {},
}));
vi.mock("@/lib/work-order-bids-storage", () => ({
  upsertWorkOrderBid: () => {},
  WORK_ORDER_BIDS_EVENT: "work-order-bids",
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [],
  readManagerWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => {},
  updateManagerWorkOrder: () => {},
}));

const PAID_INVOICE = {
  id: "inv-1",
  vendorId: "vendor-1",
  workOrderId: null,
  invoiceNumber: "INV-1001",
  lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 15000, amountCents: 15000 }],
  subtotalCents: 15000,
  taxCents: 0,
  totalCents: 15000,
  currency: "usd",
  status: "paid",
  memo: null,
  decisionNote: null,
  billId: null,
  submittedAt: "2026-09-10T00:00:00.000Z",
  decidedAt: "2026-09-11T00:00:00.000Z",
  paidAt: "2026-09-12T00:00:00.000Z",
};

// The vendor_payouts row this invoice settled through — invoice_id set,
// work_order_id null, exactly the "Request payment" shape (migration
// 20260927180000_vendor_banking.sql).
const INVOICE_PAYOUT = {
  id: "payout-inv-1",
  workOrderId: null,
  invoiceId: "inv-1",
  amountCents: 15000,
  stripeTransferId: "tr_456",
  status: "paid" as const,
  failureReason: null,
  createdAt: "2026-09-12T00:00:00.000Z",
};

vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: async () => ({ ok: true, payouts: [INVOICE_PAYOUT] }),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (url.includes("/api/vendor/invoices")) {
      return { ok: true, json: async () => ({ invoices: [PAID_INVOICE], linkedManagers: [] }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }),
);

import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

describe("paid invoice row linked to a vendor-banking payout", () => {
  it("opens the payout's banking detail page, not the plain invoice detail", async () => {
    render(
      <AppUiProvider>
        <VendorFinancesPanel tabId="income" segment="paid" />
      </AppUiProvider>,
    );
    // The invoice is paid, so it sits on the Paid segment (Pending · Paid · Overdue).
    const row = await screen.findByText("INV-1001");
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith("/vendor/financials/payouts/payout-inv-1");
    expect(navigate).not.toHaveBeenCalledWith("/vendor/financials/invoices/inv-1");
  });
});
