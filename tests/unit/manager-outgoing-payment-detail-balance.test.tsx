// @vitest-environment jsdom
/**
 * C098: "Pay from balance" on an outgoing vendor payment, dark-launched
 * behind WORKSPACE_CONNECT_ENABLED (surfaced here as
 * `/api/portal/proplane-balance`'s `workspaceConnectEnabled` field) plus the
 * underlying PropLane balance itself, with an ACH fallback when the balance
 * is short. Reuses the existing `/api/portal/work-orders/approve-pay` route
 * (already supports `paymentChannel: "balance"` server-side) — this test
 * only proves the UI wiring, not the money-move logic itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoManagerOutgoingPaymentRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  syncManagerWorkOrdersFromServer: vi.fn(async () => undefined),
  updateManagerWorkOrder: vi.fn(),
}));

import { ManagerOutgoingPaymentDetail } from "@/components/portal/pro-outgoing-payment-detail";

function vendor(overrides: Partial<ManagerVendorRow> = {}): ManagerVendorRow {
  return {
    id: "v1",
    managerUserId: "m1",
    name: "Ace HVAC",
    trade: "HVAC",
    phone: "",
    email: "",
    notes: "",
    active: true,
    achPaymentsEnabled: true,
    ...overrides,
  };
}

const row: DemoManagerOutgoingPaymentRow = {
  id: "wo-1",
  propertyName: "Oak",
  categoryLabel: "Vendor payment",
  payeeLabel: "Ace HVAC",
  chargeTitle: "Fix AC",
  amountLabel: "$120.00",
  dueDate: "Jul 1",
  bucket: "pending",
  statusLabel: "Awaiting approval",
  workOrderId: "wo-1",
  vendorPaymentMethods: ["ach"],
  achAvailable: true,
};

const workOrder: DemoManagerWorkOrderRow = {
  id: "wo-1",
  propertyName: "Oak",
  unit: "1",
  title: "Fix AC",
  priority: "normal",
  status: "approved",
  bucket: "scheduled",
  description: "AC repair",
  scheduled: "",
  cost: "120",
};

function mockFetch({ balanceEligible, approveResponse }: { balanceEligible: boolean; approveResponse?: unknown }) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/portal/proplane-balance") {
      return Response.json({ enabled: true, workspaceConnectEnabled: balanceEligible, availableCents: 5000, pendingCents: 0, currency: "usd" });
    }
    if (url.startsWith("/api/portal/work-orders/approve-pay?")) {
      return Response.json({ existingPayout: null });
    }
    if (url === "/api/portal/work-orders/approve-pay" && method === "POST") {
      return Response.json(approveResponse ?? { workOrder });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagerOutgoingPaymentDetail — Pay from balance (C098)", () => {
  it("does not offer 'PropLane balance' until eligibility resolves true", async () => {
    mockFetch({ balanceEligible: false });
    render(<ManagerOutgoingPaymentDetail row={row} workOrder={workOrder} vendor={vendor()} />);

    await waitFor(() => expect(screen.queryByText("Bank (ACH)")).toBeTruthy());
    expect(screen.queryByText("PropLane balance")).toBeNull();
  });

  it("offers and defaults to 'PropLane balance' once WORKSPACE_CONNECT_ENABLED and the balance are both on", async () => {
    mockFetch({ balanceEligible: true });
    render(<ManagerOutgoingPaymentDetail row={row} workOrder={workOrder} vendor={vendor()} />);

    await waitFor(() => expect(screen.getByText("PropLane balance")).toBeTruthy());
    const balanceOption = document.querySelector('[data-attr="manager-outgoing-payment-method-balance"]');
    expect(balanceOption?.className).toContain("border-primary");
  });

  it("falls back to ACH, without an error dead-end, when the balance is short", async () => {
    const calls = mockFetch({
      balanceEligible: true,
      approveResponse: undefined,
    });
    // Override the POST branch for this test to return the insufficient-balance shape.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url === "/api/portal/proplane-balance") {
        return Response.json({ enabled: true, workspaceConnectEnabled: true, availableCents: 500, pendingCents: 0, currency: "usd" });
      }
      if (url.startsWith("/api/portal/work-orders/approve-pay?")) return Response.json({ existingPayout: null });
      if (url === "/api/portal/work-orders/approve-pay" && method === "POST") {
        return new Response(
          JSON.stringify({
            error: "The PropLane balance has 5.00 available; this job needs 120.00. Pay by card instead.",
            code: "insufficient_balance",
            availableCents: 500,
            requestedCents: 12000,
            shortfallCents: 11500,
          }),
          { status: 422 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<ManagerOutgoingPaymentDetail row={row} workOrder={workOrder} vendor={vendor()} />);
    await waitFor(() => expect(screen.getByText("PropLane balance")).toBeTruthy());

    fireEvent.click(document.querySelector('[data-attr="manager-outgoing-payment-pay"]')!);
    await waitFor(() => expect(screen.getByText("Confirm vendor payment")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Approve & pay"));
    });

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "The PropLane balance has 5.00 available; this job needs 120.00. Pay by card instead.",
      ),
    );
    // The confirm step stays open on ACH, ready to re-submit — never a dead end.
    expect(screen.getByText("Confirm vendor payment")).toBeTruthy();
  });
});
