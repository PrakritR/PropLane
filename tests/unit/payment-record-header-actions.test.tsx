// @vitest-environment jsdom
//
// PLAN-0920-2357 stream B: the payment record page's header icon actions
// ("Record payment", "Send reminder", "Delete") used to fall through to a
// visible "Coming soon" toast for every id but "send-reminder". Record
// payment now reuses the same reversible mark-as-paid path the detail page's
// own "Mark as paid" button uses, and Delete calls `removePayment`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";
import { markHouseholdChargePaid, deleteHouseholdCharge } from "@/lib/household-charges";

const navigate = vi.fn();
const showToast = vi.fn();
const confirmMock = vi.fn(async () => true);

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => navigate,
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => confirmMock,
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => "mgr-test",
}));

vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));

vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return {
    ...actual,
    markHouseholdChargePaid: vi.fn(() => true),
    deleteHouseholdCharge: vi.fn(() => true),
  };
});

vi.mock("@/components/portal/payment-schedule-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/payment-schedule-ui")>();
  return {
    ...actual,
    useScheduledPaymentMessages: () => ({ messages: [], settings: null, reload: async () => undefined }),
  };
});

vi.stubGlobal(
  "fetch",
  async () =>
    new Response(JSON.stringify({ messages: [], settings: null, rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

afterEach(() => {
  cleanup();
  navigate.mockClear();
  showToast.mockClear();
  confirmMock.mockClear();
  vi.mocked(markHouseholdChargePaid).mockClear();
  vi.mocked(deleteHouseholdCharge).mockClear();
});

function sampleRow(overrides: Partial<DemoManagerPaymentLedgerRow> = {}): DemoManagerPaymentLedgerRow {
  return {
    id: "hc_test_1",
    propertyName: "The Magnolia",
    roomNumber: "2B",
    residentName: "Maya Chen",
    residentEmail: "maya@example.com",
    chargeTitle: "July rent",
    lineAmount: "$1,850.00",
    amountPaid: "$0.00",
    balanceDue: "$1,850.00",
    dueDate: "Jul 1, 2026",
    dueDateSortMs: Date.parse("2026-07-01"),
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    householdChargeId: "hc_test_1",
    ...overrides,
  };
}

function renderDetail(row: DemoManagerPaymentLedgerRow) {
  return render(
    <ManagerPaymentsLedgerPanel
      rows={[row]}
      managerUserId="mgr-test"
      activeBucket="pending"
      direction="incoming"
      listBasePath="/portal"
      paymentId={row.id}
    />,
  );
}

describe("payment record page header actions", () => {
  it("wires Record payment to the reversible mark-as-paid path — never Coming soon", async () => {
    renderDetail(sampleRow());
    const button = document.querySelector('[data-attr="record-header-action-record-payment"]')!;
    fireEvent.click(button);

    await waitFor(() => expect(markHouseholdChargePaid).toHaveBeenCalledTimes(1));
    expect(markHouseholdChargePaid).toHaveBeenCalledWith("hc_test_1", "mgr-test", undefined);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Marked as paid.", expect.anything()));
    expect(showToast).not.toHaveBeenCalledWith("Coming soon");
  });

  it("wires Delete to removePayment (confirm, then delete) — never Coming soon", async () => {
    renderDetail(sampleRow());
    const button = document.querySelector('[data-attr="record-header-action-delete"]')!;
    fireEvent.click(button);

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deleteHouseholdCharge).toHaveBeenCalledTimes(1));
    expect(deleteHouseholdCharge).toHaveBeenCalledWith("hc_test_1", "mgr-test", undefined);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Payment removed."));
    expect(showToast).not.toHaveBeenCalledWith("Coming soon");
    expect(navigate).toHaveBeenCalled();
  });

  it("still wires Send reminder — unaffected by the record-payment/delete rewiring", () => {
    renderDetail(sampleRow());
    const button = document.querySelector('[data-attr="record-header-action-send-reminder"]');
    expect(button).toBeTruthy();
  });
});
