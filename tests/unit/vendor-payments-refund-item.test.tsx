// @vitest-environment jsdom
//
// Payments row ⋯ Refund (vendor-banking-1006): present only when the payment is
// refundable AND the refund flag (reported by the one balance snapshot) is on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";

const navigate = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ refundsEnabled: true, payoutStatus: "paid" as string, refunded: 0 }));
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
  fetchVendorPayoutsResult: async () => ({
    ok: true,
    payouts: [{ id: "vp1", workOrderId: null, invoiceId: "i-paid", amountCents: 20_500, stripeTransferId: null, status: state.payoutStatus, failureReason: null, createdAt: new Date().toISOString(), platformFeeCents: 615, refundedGrossCents: state.refunded }],
  }),
}));
vi.mock("@/components/portal/vendor-refund-modal", () => ({
  VendorRefundModal: ({ open, initialPayoutId }: { open: boolean; initialPayoutId?: string | null }) =>
    open ? <div data-attr="refund-modal-stub">Refund {initialPayoutId}</div> : null,
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => {},
}));

const invoice = {
  id: "i-paid", vendorId: "v1", workOrderId: null, invoiceNumber: "INV-3", totalCents: 20_500, status: "paid", paidAt: new Date().toISOString(),
  dueDate: null, lineItems: [], subtotalCents: 0, taxCents: 0, currency: "usd", memo: null, decisionNote: null, billId: null, decidedAt: null,
  paidFrom: null, submittedAt: new Date().toISOString(),
};
const balance = () => ({
  currency: "usd", availableCents: 0, instantAvailableCents: 0, pendingCents: 0, onTheWayCents: 0, withdrawableCents: 0, heldCents: 0,
  releasePendingCents: 0, recoveryOutstandingCents: 0, recoveryReservedCents: 0, bank: null, schedule: { interval: "manual", nextPayoutAt: null },
  setup: { identity: "done", bank: "done", ready: true }, history: [], feeBps: 300, refundsEnabled: state.refundsEnabled,
});

beforeEach(() => {
  navigate.mockClear();
  state.refundsEnabled = true;
  state.payoutStatus = "paid";
  state.refunded = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (u.includes("/api/vendor/payouts/balance")) return ok(balance());
    if (u.includes("/api/vendor/invoices")) return ok({ invoices: [invoice], linkedManagers: [] });
    return ok({});
  }));
});
afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

async function menuLabels(): Promise<string[]> {
  render(<AppUiProvider><VendorFinancesPanel tabId="income" /></AppUiProvider>);
  await waitFor(() => expect(document.querySelector('[data-attr="vendor-payments-tab-paid"]')).toBeTruthy());
  fireEvent.click(document.querySelector('[data-attr="vendor-payments-tab-paid"]') as HTMLElement);
  await screen.findByText("INV-3");
  // let the balance snapshot settle before reading the menu
  await new Promise((r) => setTimeout(r, 50));
  fireEvent.pointerDown(document.querySelector('[data-attr="vendor-payment-row-menu"]') as HTMLElement, { button: 0, ctrlKey: false });
  return within(await screen.findByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent ?? "");
}

describe("Payments row ⋯ Refund", () => {
  it("is offered for a settled payment when the refund flag is on, and opens the Refund a payment pop-up on it", async () => {
    const labels = await menuLabels();
    expect(labels).toContain("Refund");
    fireEvent.click(screen.getByText("Refund"));
    expect(await screen.findByText("Refund vp1")).toBeTruthy();
  });

  it("is absent when the refund flag is off", async () => {
    state.refundsEnabled = false;
    expect(await menuLabels()).not.toContain("Refund");
  });

  it("is absent once the payment is fully refunded", async () => {
    state.payoutStatus = "refunded";
    state.refunded = 20_500;
    expect(await menuLabels()).not.toContain("Refund");
  });
});
