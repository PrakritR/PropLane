// @vitest-environment jsdom
//
// Within the Pending bucket, a charge not yet due this month or earlier
// stays in the same flat list after everything due now — and drops out
// entirely once the manager's `showUpcomingCharges` setting is off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => async () => true,
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => "mgr-test" }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function row(overrides: Partial<DemoManagerPaymentLedgerRow> = {}): DemoManagerPaymentLedgerRow {
  return {
    id: "hc_due_now",
    propertyName: "The Magnolia",
    roomNumber: "2B",
    residentName: "Maya Chen",
    residentEmail: "maya@example.com",
    chargeTitle: "September rent",
    lineAmount: "$1,850.00",
    amountPaid: "$0.00",
    balanceDue: "$1,850.00",
    dueDate: "Sep 20, 2026",
    dueDateSortMs: Date.parse("2026-09-20"), // due-now: same month as "now"
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    householdChargeId: "hc_due_now",
    ...overrides,
  };
}

function upcomingRow(overrides: Partial<DemoManagerPaymentLedgerRow> = {}): DemoManagerPaymentLedgerRow {
  return row({
    id: "hc_upcoming",
    householdChargeId: "hc_upcoming",
    chargeTitle: "October rent",
    dueDate: "Oct 15, 2026",
    dueDateSortMs: Date.parse("2026-10-15"), // a later calendar month than "now"
    ...overrides,
  });
}

function renderPending(rows: DemoManagerPaymentLedgerRow[], showUpcomingCharges = true) {
  return render(
    <ManagerPaymentsLedgerPanel
      rows={rows}
      managerUserId="mgr-test"
      activeBucket="pending"
      direction="incoming"
      onAddPayment={() => undefined}
      showUpcomingCharges={showUpcomingCharges}
    />,
  );
}

describe("manager Payments — upcoming charges stay in the flat list", () => {
  it("lists due-now charges first, then later-month charges, with no Upcoming heading", () => {
    const { container } = renderPending([row(), upcomingRow()], true);

    expect(container.querySelector('[data-attr="payments-upcoming-section"]')).toBeNull();
    expect(container.textContent).not.toContain("Upcoming");

    const rows = Array.from(container.querySelectorAll('[data-attr="payment-list-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("September rent");
    expect(rows[1]?.textContent).toContain("October rent");
  });

  it("excludes later-month charges entirely when Hide is set", () => {
    const { container } = renderPending([row(), upcomingRow()], false);

    expect(container.querySelector('[data-attr="payments-upcoming-section"]')).toBeNull();
    const rows = Array.from(container.querySelectorAll('[data-attr="payment-list-row"]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("September rent");
    expect(container.textContent).not.toContain("October rent");
  });

  it("does not invent an Upcoming heading when every charge is due now", () => {
    const { container } = renderPending([row()], true);
    expect(container.querySelector('[data-attr="payments-upcoming-section"]')).toBeNull();
    expect(container.textContent).not.toContain("Upcoming");
  });

  it("still appends later-month charges last when the list is ordered by property", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[
          row({ id: "a", propertyName: "House A" }),
          upcomingRow({ id: "b", propertyName: "House B" }),
        ]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        groupMode="house"
        onAddPayment={() => undefined}
        showUpcomingCharges
      />,
    );

    const surface = container.querySelector('[data-attr="payments-house-groups"]');
    expect(surface).toBeTruthy();
    expect(container.querySelector('[data-attr="payments-upcoming-section"]')).toBeNull();
    const rows = Array.from(container.querySelectorAll('[data-attr="payment-list-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("House A");
    expect(rows[1]?.textContent).toContain("House B");
  });

  it("never splits Overdue or Paid into an upcoming section", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[row({ id: "od", bucket: "overdue", statusLabel: "Overdue", dueDateSortMs: Date.parse("2026-08-01") })]}
        managerUserId="mgr-test"
        activeBucket="overdue"
        direction="incoming"
        onAddPayment={() => undefined}
        showUpcomingCharges
      />,
    );
    expect(container.querySelector('[data-attr="payments-upcoming-section"]')).toBeNull();
  });
});
