// @vitest-environment jsdom
//
// Vendor Payments (vendor-portal-redesign-1006): Pending · Paid · Overdue tabs
// with counts and the shared row with ⋯ View invoice · Download.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";

const navigate = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: async () => ({ ok: true, payouts: [] }),
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [
    { id: "wo1", title: "Kitchen sink leak", managerName: "Alder Property Co", propertyName: "12 Oak St", unit: "—", propertyId: "p1" },
  ],
  syncManagerWorkOrdersFromServer: async () => {},
}));

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const base = {
  vendorId: "v1",
  lineItems: [],
  subtotalCents: 0,
  taxCents: 0,
  currency: "usd",
  memo: null,
  decisionNote: null,
  billId: null,
  decidedAt: null,
  paidFrom: null,
  submittedAt: new Date().toISOString(),
};
const INVOICES = [
  { ...base, id: "i-pending", workOrderId: "wo1", invoiceNumber: "INV-1", totalCents: 18000, status: "approved", paidAt: null, dueDate: day(7) },
  { ...base, id: "i-overdue", workOrderId: null, invoiceNumber: "INV-2", totalCents: 24000, status: "approved", paidAt: null, dueDate: day(-3) },
  { ...base, id: "i-paid", workOrderId: null, invoiceNumber: "INV-3", totalCents: 9000, status: "paid", paidAt: new Date().toISOString(), dueDate: day(-10) },
];
const BALANCE = {
  currency: "usd", availableCents: 42000, instantAvailableCents: 0, pendingCents: 0, onTheWayCents: 18000,
  withdrawableCents: 42000, heldCents: 0, releasePendingCents: 0, recoveryOutstandingCents: 0, recoveryReservedCents: 0,
  bank: null, schedule: { interval: "manual", nextPayoutAt: null }, setup: { identity: "done", bank: "done", ready: true },
  history: [], feeBps: 50,
};

beforeEach(() => {
  navigate.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/vendor/payouts/balance")) return ok(BALANCE);
      if (u.includes("/api/vendor/stripe-connect/bank-accounts"))
        return ok({ destinations: [{ id: "ba_1", kind: "bank", label: "Chase", last4: "4421", status: "new", payable: true, instantEligible: false, default: true }] });
      if (u.includes("/api/vendor/invoices")) return ok({ invoices: INVOICES, linkedManagers: [] });
      return ok({});
    }),
  );
});
afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

const renderPanel = () =>
  render(
    <AppUiProvider>
      <VendorFinancesPanel tabId="income" />
    </AppUiProvider>,
  );
const tab = (id: string) => document.querySelector(`[data-attr="vendor-payments-tab-${id}"]`) as HTMLElement;

describe("vendor Payments tabs", () => {
  it("shows Pending · Paid · Overdue with counts, defaulting to Pending", async () => {
    renderPanel();
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-invoice-row"]')).toHaveLength(1));
    expect(tab("pending").textContent).toContain("1");
    expect(tab("paid").textContent).toContain("1");
    expect(tab("overdue").textContent).toContain("1");
    // Pending: the approved invoice due next week, named by its service and manager.
    expect(screen.getByText("Kitchen sink leak")).toBeTruthy();
    expect(screen.getByText("Alder Property Co")).toBeTruthy();
  });

  it("Overdue lists the unpaid invoice past its due date; Paid lists the paid one", async () => {
    renderPanel();
    await waitFor(() => expect(tab("overdue")).toBeTruthy());
    fireEvent.click(tab("overdue"));
    await waitFor(() => expect(screen.getByText("INV-2")).toBeTruthy());
    expect(screen.queryByText("Kitchen sink leak")).toBeNull();
    fireEvent.click(tab("paid"));
    await waitFor(() => expect(screen.getByText("INV-3")).toBeTruthy());
    expect(screen.queryByText("INV-2")).toBeNull();
  });

  it("the row ⋯ carries View invoice and Download (paid), and no Message the manager", async () => {
    renderPanel();
    await waitFor(() => expect(tab("paid")).toBeTruthy());
    fireEvent.click(tab("paid"));
    await screen.findByText("INV-3");
    fireEvent.pointerDown(document.querySelector('[data-attr="vendor-payment-row-menu"]') as HTMLElement, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View invoice", "Download"]);
    expect(within(menu).queryByText("Message the manager")).toBeNull();
  });

  it("the Payments tab carries no balance card (it moved to Balance & payouts); the band keeps its single Download", async () => {
    renderPanel();
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-invoice-row"]')).toHaveLength(1));
    expect(document.querySelector('[data-attr="vendor-income-balance-card"]')).toBeNull();
    expect(document.querySelectorAll('[data-attr="vendor-export-invoices-csv"]')).toHaveLength(1);
  });

  it("the band's gear is a link to Settings → Payouts, not a pop-up", async () => {
    renderPanel();
    const gear = await waitFor(() => {
      const el = document.querySelector('[data-attr="vendor-finances-payout-setup"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(gear.getAttribute("data-gear-target")).toBe("/vendor/profile?tab=payouts");
    fireEvent.click(gear);
    expect(navigate).toHaveBeenCalledWith("/vendor/profile?tab=payouts");
  });

  it("a submitted invoice's ⋯ says Retract invoice (never Withdraw, which moves money)", async () => {
    INVOICES.push({ ...base, id: "i-sub", workOrderId: null, invoiceNumber: "INV-9", totalCents: 5000, status: "submitted", paidAt: null, dueDate: null } as never);
    try {
      renderPanel();
      await screen.findByText("INV-9");
      const row = screen.getByText("INV-9").closest(".portal-property-row") as HTMLElement;
      fireEvent.pointerDown(row.querySelector('[data-attr="vendor-payment-row-menu"]') as HTMLElement, { button: 0, ctrlKey: false });
      const labels = within(await screen.findByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent);
      expect(labels).toContain("Retract invoice");
      expect(labels).not.toContain("Withdraw");
    } finally {
      INVOICES.pop();
    }
  });

  it("the payout record header still offers no Refund; the row ⋯ Refund is mounted only behind the flag", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/portal/vendor-finances-panel.tsx", "utf8");
    expect(src).toContain('if (action.id === "refund") return false;');
    expect(src).toContain("{refundConfig.enabled ? (");
    expect(src).toContain("isVendorPaymentRefundable(row.payout, refundsEnabled)");
  });
});
