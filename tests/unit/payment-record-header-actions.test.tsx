// @vitest-environment jsdom
//
// C2-PAY1/PAY3: header icons (take payment, mark paid offline sheet, send
// reminder, edit, download, delete on unpaid; refund on paid. Settled cash has
// no accounting-safe Move to pending action.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";
import { markHouseholdChargePaid, deleteHouseholdCharge } from "@/lib/household-charges";

const navigate = vi.fn();
const showToast = vi.fn();
const confirmMock = vi.fn(async () => true);
const storedCharges = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

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
    readHouseholdCharges: vi.fn(() => storedCharges.rows),
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
  storedCharges.rows = [];
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

function providerBackedPaidRow(): DemoManagerPaymentLedgerRow {
  storedCharges.rows = [{ id: "hc_test_1", status: "paid", stripeCheckoutSessionId: "cs_paid_exact" }];
  return sampleRow({ bucket: "paid", statusLabel: "Paid", amountPaid: "$1,850.00", balanceDue: "$0.00" });
}

describe("payment record page header actions", () => {
  it("opens the Mark paid offline sheet from the header — never Coming soon", () => {
    renderDetail(sampleRow());
    const button = document.querySelector('[data-attr="record-header-action-mark-paid"]')!;
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(document.body.textContent).toContain("Mark paid offline");
    expect(markHouseholdChargePaid).not.toHaveBeenCalled();
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

  it("omits unpaid-only and unaccounted reversal actions on a paid row", () => {
    renderDetail(providerBackedPaidRow());
    expect(document.querySelector('[data-attr="record-header-action-mark-paid"]')).toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-send-reminder"]')).toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-delete"]')).toBeNull();
    expect(document.querySelector('[data-attr="record-header-action-refund"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="record-header-action-move-pending"]')).toBeNull();
    expect(markHouseholdChargePaid).not.toHaveBeenCalled();
  });

  it("wires the paid-row Refund action to charge-refund, not Delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("charge-refund")) {
          return new Response(JSON.stringify({ ok: true, refundId: "re_1", remainingCents: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ messages: [], settings: null, rows: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderDetail(providerBackedPaidRow());
    const button = document.querySelector('[data-attr="record-header-action-refund"]')!;
    fireEvent.click(button);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Refunded Maya Chen."));
    expect(deleteHouseholdCharge).not.toHaveBeenCalled();
  });

  it("still wires Send reminder — unaffected by the record-payment/delete rewiring", () => {
    renderDetail(sampleRow());
    const button = document.querySelector('[data-attr="record-header-action-send-reminder"]');
    expect(button).toBeTruthy();
  });
});
