// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/manager-payments-ledger-panel";

const navigate = vi.fn();

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => navigate,
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => "mgr-test",
}));

vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));

vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return { ...actual };
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

describe("ManagerPaymentsLedgerPanel", () => {
  it("groups the main payments ledger by resident", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[
          sampleRow({ id: "hc_a", chargeTitle: "Move-in cost" }),
          sampleRow({ id: "hc_b", chargeTitle: "July rent" }),
          sampleRow({
            id: "hc_c",
            residentName: "Jordan Lee",
            residentEmail: "jordan@example.com",
            chargeTitle: "Application fee",
          }),
        ]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    expect(container.querySelector('[data-attr="payments-resident-groups"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-attr="application-household-cluster"]')).toHaveLength(2);
    expect(container.textContent).toContain("Maya Chen");
    expect(container.textContent).toContain("Jordan Lee");
    expect(container.textContent).toContain("2 charges");
  });

  it("uses charge-style DataList cards on the main payments ledger", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    expect(container.querySelector('[data-slot="data-list"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="data-list-mobile-row"]')).toBeTruthy();
    const mobileRow = container.querySelector('[data-slot="data-list-mobile-row"]');
    expect(mobileRow?.textContent).toContain("July rent");
    expect(mobileRow?.textContent).toContain("$1,850.00");
    expect(container.querySelector('[data-attr="payment-list-row"]')).toBeNull();
  });

  it("shows compact reminder copy on grouped charge rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    try {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow({ id: "hc_rem", householdChargeId: "hc_rem" })]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        scheduledMessages={[
          {
            id: "msg-1",
            chargeId: "hc_rem",
            kind: "before_due",
            daysBeforeDue: 7,
            sendAt: "2026-08-28T07:00:00.000Z",
            visibleFrom: "2026-08-21T07:00:00.000Z",
            dueDate: "2026-09-11",
            dueDateLabel: "Sep 11, 2026",
            residentName: "Maya Chen",
            residentEmail: "maya@example.com",
            chargeTitle: "July rent",
            propertyLabel: "The Magnolia",
            balanceDue: "$1,850.00",
            subject: "Reminder",
            body: "Please pay",
            status: "scheduled",
          },
          {
            id: "msg-2",
            chargeId: "hc_rem",
            kind: "before_due",
            daysBeforeDue: 3,
            sendAt: "2026-09-04T07:00:00.000Z",
            visibleFrom: "2026-08-28T07:00:00.000Z",
            dueDate: "2026-09-11",
            dueDateLabel: "Sep 11, 2026",
            residentName: "Maya Chen",
            residentEmail: "maya@example.com",
            chargeTitle: "July rent",
            propertyLabel: "The Magnolia",
            balanceDue: "$1,850.00",
            subject: "Reminder",
            body: "Please pay",
            status: "scheduled",
          },
        ]}
        onAddPayment={() => undefined}
      />,
    );

    const mobileRow = container.querySelector('[data-slot="data-list-mobile-row"]');
    expect(mobileRow?.textContent).toContain("Next reminder");
    expect(mobileRow?.textContent).toContain("(+1 more)");
    expect(mobileRow?.textContent).not.toContain("Reminders scheduled:");
    expect(mobileRow?.textContent).not.toContain("The Magnolia");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses resident-style DataList cards when embedded in a resident profile", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        onAddPayment={() => undefined}
      />,
    );

    expect(container.querySelector('[data-slot="data-list"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="data-list-mobile-row"]')).toBeTruthy();
    const mobileRow = container.querySelector('[data-slot="data-list-mobile-row"]');
    expect(mobileRow?.textContent).toContain("July rent");
    expect(mobileRow?.textContent).toContain("$1,850.00");
    expect(container.querySelector('[data-attr="payment-list-row"]')).toBeNull();
  });

  it("does not render a dashed list add row on the main ledger list", () => {
    render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: /Add charge/i })).toBeNull();
    expect(screen.queryByTestId("payments-list-add")).toBeNull();
  });

  it("does not render a dashed list add row when embedded in resident", () => {
    render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        onAddPayment={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: /Add payment/i })).toBeNull();
  });

  it("opens embedded charge detail via DataList row click", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        buildPaymentDetailHref={(row) => `/portal/residents/approved/r1/payments/pending/${row.id}`}
      />,
    );

    const mobileRow = container.querySelector('[data-slot="data-list-mobile-row"]');
    expect(mobileRow).toBeTruthy();
    fireEvent.click(mobileRow!);
    expect(navigate).toHaveBeenCalledWith("/portal/residents/approved/r1/payments/pending/hc_test_1");
  });
});
