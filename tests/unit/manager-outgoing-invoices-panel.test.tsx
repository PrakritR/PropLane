// @vitest-environment jsdom
// Operations > Outgoing payments (studio C2-OUT1 / C2-OUT2): the row reads "Due / Pays / Paid <date>" plus the method,
// a row opens a record page (Payment · Communication) and the header offers only what the server can do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ManagerOutgoingInvoicesPanel } from "@/components/portal/manager-outgoing-invoices-panel";

const navigate = vi.fn();
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/outgoing/to-pay",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/manager-vendors-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-vendors-storage")>()),
  readManagerVendorRows: () => [],
  syncManagerVendorsFromServer: async () => [],
}));

const base = {
  vendorId: "roster-1", vendorUserId: "vu-1", vendorName: "Brightline Plumbing", workOrderId: "wo-1", serviceTitle: "Burst pipe", propertyName: "Alder House",
  invoiceNumber: "IV4", lineItems: [{ description: "Labor", quantity: 2, unitAmountCents: 50000, amountCents: 100000 }], subtotalCents: 100000, taxCents: 0, totalCents: 100000,
  currency: "usd", memo: null, decisionNote: null, billId: null, submittedAt: "2026-09-10T12:00:00.000Z", decidedAt: "2026-09-10T12:00:00.000Z", paidAt: null, paidFrom: null,
};
const VENDOR_BILLED = { ...base, id: "inv-vendor", status: "approved" };
const MANAGER_BILLED = { ...base, id: "inv-mine", status: "approved", managerEntered: true, serviceTitle: "Closet door", totalCents: 13200 };

function mockFetch(balance?: { availableCents: number; defaultPaymentSource: string }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    const body = path.startsWith("/api/manager/vendor-invoices?status")
      ? { invoices: [VENDOR_BILLED, MANAGER_BILLED], payouts: [], totals: { owedCents: 0, paidThisYearCents: 0 } }
      : path === "/api/portal/proplane-balance" && balance
        ? { enabled: true, availableCents: balance.availableCents }
        : path === "/api/portal/payment-preferences" && balance
          ? { defaultPaymentSource: balance.defaultPaymentSource }
          : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

const renderPanel = (props: Partial<React.ComponentProps<typeof ManagerOutgoingInvoicesPanel>> = {}) =>
  render(<AppUiProvider><ManagerOutgoingInvoicesPanel tabId="to-pay" basePath="/portal" {...props} /></AppUiProvider>);

describe("Outgoing payments list", () => {
  beforeEach(() => { navigate.mockReset(); mockFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("reads Due <date> and the method on a to-pay row, with cents on the figure", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByText("Brightline Plumbing").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/^Due Sep 17, 2026$/).length).toBe(2);
    // The planned method defaults to the card/bank rail: the PropLane balance is
    // offered (and becomes the planned method) only once the balance is enabled
    // for this manager, so a to-pay row never promises a rail that is not on.
    expect(screen.getAllByText("Card or bank account").length).toBe(2);
    expect(screen.queryByText("PropLane balance")).toBeNull();
    expect(screen.getAllByText("$1,000.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$132.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Approved/)).toBeNull();
  });

  it("totals each tab from the very rows it counts, in hairline stat cards above the rows", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByText("Brightline Plumbing").length).toBeGreaterThan(0));
    expect(document.querySelector('[data-attr="outgoing-stat-to-pay"]')?.textContent).toBe("$1,132.00");
    expect(document.querySelector('[data-attr="outgoing-stat-scheduled"]')?.textContent).toBe("$0.00");
    expect(document.querySelector('[data-attr="outgoing-stat-paid"]')?.textContent).toBe("$0.00");
  });

  it("offers the PropLane balance in Pay vendor, with the available figure, only when the balance is enabled and covers the bill", async () => {
    mockFetch({ availableCents: 500_000, defaultPaymentSource: "balance" });
    renderPanel({ paymentId: "inv-vendor" });
    await waitFor(() => expect(screen.getByText("Billed by")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    await waitFor(() => expect(screen.getAllByText(/PropLane balance/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/PropLane balance · \$5,000\.00 available/).length).toBeGreaterThan(0);
  });

  it("shows the standard empty card, not a bare sentence, on an empty tab", async () => {
    renderPanel({ tabId: "scheduled" });
    await waitFor(() => expect(screen.getByText("Nothing scheduled")).toBeTruthy());
  });
});

describe("Outgoing payment record page", () => {
  beforeEach(() => { navigate.mockReset(); mockFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("a vendor-issued bill has no Delete bill, Dispute or Void request; Pay now is the last header action", async () => {
    renderPanel({ paymentId: "inv-vendor" });
    await waitFor(() => expect(screen.getByText("Billed by")).toBeTruthy());
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["View invoice", "Schedule payment", "Mark paid", "Pay now"]));
    // Message lives in the record's Communication tab; the header carries no second door to it.
    expect(labels).not.toContain("Message vendor");
    expect(labels).not.toContain("Delete bill");
    expect(labels).not.toContain("Dispute / Request change");
    expect(labels).not.toContain("Void request");
    const header = labels.filter((l) => ["View invoice", "Schedule payment", "Mark paid", "Pay now"].includes(l!));
    expect(header[header.length - 1]).toBe("Pay now");
    expect(screen.getAllByText("Payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Communication").length).toBeGreaterThan(0);
    expect(screen.getByText("History")).toBeTruthy();
  });

  it("a bill the manager typed in offers a red Delete bill before Pay now", async () => {
    renderPanel({ paymentId: "inv-mine" });
    await waitFor(() => expect(screen.getByText("You (entered by hand)")).toBeTruthy());
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")).filter(Boolean);
    expect(labels.indexOf("Delete bill")).toBeGreaterThan(-1);
    expect(labels.indexOf("Delete bill")).toBeLessThan(labels.indexOf("Pay now"));
  });

  it("an unknown id says the payment is gone", async () => {
    renderPanel({ paymentId: "nope" });
    await waitFor(() => expect(screen.getByText("This payment is gone")).toBeTruthy());
  });
});
