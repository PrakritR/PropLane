// @vitest-environment jsdom
//
// A resident's own Payments tab groups by WHERE THE MONEY STANDS. Grouping by
// resident is meaningless there — there is only one — so every charge used to
// sit in one undifferentiated list and "what is still owed, and what is late"
// had to be read off individual due dates.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";

vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
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

afterEach(cleanup);

function row(overrides: Partial<DemoManagerPaymentLedgerRow> = {}): DemoManagerPaymentLedgerRow {
  return {
    id: "hc_1",
    propertyName: "4709A 8th Ave NE",
    roomNumber: "Room 2",
    residentName: "Sohan Vivek Naik",
    residentEmail: "sohan@example.com",
    chargeTitle: "Rent — October 2026",
    lineAmount: "$800.00",
    amountPaid: "$0.00",
    balanceDue: "$800.00",
    dueDate: "Oct 1, 2026",
    dueDateSortMs: Date.parse("2026-10-01"),
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    householdChargeId: "hc_1",
    ...overrides,
  };
}

function renderResidentTab(rows: DemoManagerPaymentLedgerRow[]) {
  return render(
    <ManagerPaymentsLedgerPanel
      rows={rows}
      managerUserId="mgr-test"
      activeBucket="pending"
      direction="incoming"
      embeddedInResident
    />,
  );
}

describe("resident Payments tab — status sections", () => {
  it("splits the resident's charges into Overdue, Pending and Paid", () => {
    const { container } = renderResidentTab([
      row({ id: "a", bucket: "overdue", chargeTitle: "Security deposit" }),
      row({ id: "b", bucket: "pending", chargeTitle: "Rent — October 2026" }),
      row({ id: "c", bucket: "paid", chargeTitle: "Application fee" }),
    ]);

    expect(container.querySelector('[data-attr="payments-status-section-overdue"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="payments-status-section-pending"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="payments-status-section-paid"]')).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Paid")).toBeTruthy();
  });

  it("orders the sections money-first: overdue, then pending, then paid", () => {
    const { container } = renderResidentTab([
      row({ id: "c", bucket: "paid" }),
      row({ id: "b", bucket: "pending" }),
      row({ id: "a", bucket: "overdue" }),
    ]);
    const order = Array.from(
      container.querySelectorAll('[data-attr^="payments-status-section-"]'),
    ).map((el) => el.getAttribute("data-attr"));
    expect(order).toEqual([
      "payments-status-section-overdue",
      "payments-status-section-pending",
      "payments-status-section-paid",
    ]);
  });

  it("omits a section the resident has nothing in", () => {
    const { container } = renderResidentTab([
      row({ id: "b", bucket: "pending" }),
      row({ id: "c", bucket: "paid" }),
    ]);
    expect(container.querySelector('[data-attr="payments-status-section-overdue"]')).toBeNull();
    expect(container.querySelector('[data-attr="payments-status-section-pending"]')).toBeTruthy();
  });

  it("stays a plain list when every charge is in one state", () => {
    // Headers over a single section would be chrome with nothing to separate.
    const { container } = renderResidentTab([row({ id: "a" }), row({ id: "b", chargeTitle: "Utilities" })]);
    expect(container.querySelector('[data-attr="payments-resident-status-sections"]')).toBeNull();
  });

  it("counts the charges in each section", () => {
    const { container } = renderResidentTab([
      row({ id: "a", bucket: "overdue" }),
      row({ id: "b", bucket: "overdue", chargeTitle: "Move-in cost" }),
      row({ id: "c", bucket: "paid" }),
    ]);
    const overdue = container.querySelector('[data-attr="payments-status-section-overdue"]');
    expect(overdue?.textContent).toContain("2");
  });
});
