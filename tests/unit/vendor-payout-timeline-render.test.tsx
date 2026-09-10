// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/payments",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/components/portal/gmail-payment-auto-track-panel", () => ({
  GmailPaymentAutoTrackPanel: () => null,
}));
vi.mock("@/components/portal/vendor-payment-methods-modal", () => ({
  VendorPaymentMethodsModal: () => null,
}));

const workOrders: Array<Record<string, unknown>> = [];
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "axis:manager-work-orders",
  readVendorWorkOrderRows: () => workOrders,
  syncManagerWorkOrdersFromServer: () => Promise.resolve(),
}));

const payouts: Array<Record<string, unknown>> = [];
vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: () => Promise.resolve({ ok: true, payouts }),
}));

import { VendorPaymentsPanel } from "@/components/portal/vendor-payments-panel";
import { VendorPayoutTimeline } from "@/components/portal/vendor-payout-timeline";
import { vendorPayoutTimeline } from "@/lib/vendor-payout-timeline";

const paidWorkOrder = {
  id: "wo_1",
  title: "Fix the boiler",
  propertyName: "Oak House",
  unit: "2B",
  bucket: "completed",
  automationStatus: "paid",
  paidAt: "2026-09-01T16:59:00.000Z",
  completedAt: "2026-09-01T15:00:00.000Z",
  vendorPaymentChannel: "ach",
  vendorCostCents: 12_500,
  managerName: "Alex Manager",
};

const invoicesResponse = {
  invoices: [
    { id: "inv_1", workOrderId: "wo_1", status: "approved", decidedAt: "2026-08-30T12:00:00.000Z", lineItems: [] },
  ],
};

describe("VendorPayoutTimeline", () => {
  afterEach(() => cleanup());

  it("renders every step with its date, an em dash for an unknown instant, and the failure reason", () => {
    const steps = vendorPayoutTimeline({
      payout: {
        status: "failed",
        amountCents: 12_500,
        stripeTransferId: null,
        failureReason: "Vendor's Stripe payout account has not finished onboarding.",
        createdAt: "2026-09-01T17:00:00.000Z",
        updatedAt: "2026-09-01T17:00:04.000Z",
      },
      workOrder: { paidAt: null },
    });
    render(<VendorPayoutTimeline steps={steps} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    // Approval instant is unknown here — it renders "—", never a guessed date.
    expect(within(rows[0]!).getByText("Invoice approved")).toBeInTheDocument();
    expect(within(rows[0]!).getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(within(rows[1]!).getByText(/Sep 1/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Not sent")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Payout failed")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Vendor's Stripe payout account has not finished onboarding.")).toBeInTheDocument();
    expect(rows[3]!.getAttribute("data-state")).toBe("failed");
  });
});

describe("VendorPaymentsPanel payout timeline", () => {
  beforeEach(() => {
    workOrders.splice(0, workOrders.length, paidWorkOrder);
    payouts.splice(0, payouts.length, {
      id: "payout_1",
      workOrderId: "wo_1",
      amountCents: 12_500,
      stripeTransferId: "tr_abc",
      status: "paid",
      failureReason: null,
      createdAt: "2026-09-01T17:00:00.000Z",
      updatedAt: "2026-09-01T17:00:04.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes("/api/vendor/invoices")
          ? invoicesResponse
          : { linked: true, profile: { id: "v1", name: "Vendor", achPaymentsEnabled: true } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the dated timeline for a paid job on the Paid tab, sourced from the payout, invoice and work order", async () => {
    render(<VendorPaymentsPanel />);
    // The status pills render a mobile select and the desktop pill strip; the pill is last.
    const paidPills = screen.getAllByRole("button", { name: /^Paid/ });
    fireEvent.click(paidPills[paidPills.length - 1]!);
    // Mobile cards and the desktop table both sit in the DOM under jsdom, so the title appears twice.
    await waitFor(() => expect(screen.getAllByText("Fix the boiler").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: /Expand Fix the boiler/ })[0]!);

    await waitFor(() => expect(screen.getAllByText("Payout timeline").length).toBeGreaterThan(0));
    const timeline = document.querySelector('[data-attr="vendor-payments-payout-timeline"]')!;
    const rows = within(timeline as HTMLElement).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-step"))).toEqual(["approved", "created", "transfer", "outcome"]);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "done", "done", "done"]);
    // Approval comes from the invoice's decided_at (Aug 30), not the work order's paidAt.
    expect(within(rows[0]!).getByText(/Aug 30/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Stripe transfer tr_abc")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Paid out")).toBeInTheDocument();
  });
});
