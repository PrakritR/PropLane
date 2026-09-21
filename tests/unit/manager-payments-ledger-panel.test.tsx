// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";

const navigate = vi.fn();

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => navigate,
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

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
  it("draws one card per charge with a resident's charges adjacent — no grouping box", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[
          sampleRow({ id: "hc_a", chargeTitle: "Move-in cost" }),
          sampleRow({
            id: "hc_c",
            residentName: "Jordan Lee",
            residentEmail: "jordan@example.com",
            chargeTitle: "Application fee",
          }),
          sampleRow({ id: "hc_b", chargeTitle: "July rent" }),
        ]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    expect(container.querySelector('[data-attr="payments-resident-groups"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="application-household-cluster"]')).toBeNull();
    expect(container.querySelector('[data-slot="data-list"]')).toBeNull();
    const rows = Array.from(container.querySelectorAll('[data-attr="payment-list-row"]'));
    expect(rows).toHaveLength(3);
    // Resident then due: Maya's two charges sit together even though Jordan's
    // arrived between them.
    expect(rows.map((row) => row.textContent?.includes("Maya Chen"))).toEqual([true, true, false]);
    expect(rows[2]?.textContent).toContain("Jordan Lee");
  });

  it("titles the card by the resident, places the charge and the home under it, and shows the amount", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    const row = container.querySelector('[data-attr="payment-list-row"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Maya Chen");
    expect(row?.textContent).toContain("July rent · The Magnolia · Room 2B");
    expect(row?.textContent).toContain("Due Jul 1, 2026");
    expect(container.textContent).toContain("$1,850.00");
    // No pill on the row: the tab says the bucket.
    expect(container.querySelector('[data-attr="payments-cluster-scheduled"]')).toBeNull();
  });

  it("formats an ISO due day like every other due date", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow({ dueDate: "2026-10-01" }), sampleRow({ id: "hc_2", dueDate: "Before move-in" })]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    const rows = Array.from(container.querySelectorAll('[data-attr="payment-list-row"]'));
    expect(rows[0]?.textContent).toContain("Due Oct 1, 2026");
    expect(rows[0]?.textContent).not.toContain("2026-10-01");
    expect(rows[1]?.textContent).toContain("Before move-in");
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

    // The reminder is a glyph fact on the charge row it belongs to — the
    // soonest queued send, and only that: never a count of the rest ("+1
    // more"), never a group-header pill, never a verbose list.
    const reminder = container.querySelector('[data-attr="payment-row-reminder"]');
    expect(reminder).toBeTruthy();
    expect(reminder?.textContent).toContain("Aug 28, 2026");
    expect(reminder?.textContent).not.toContain("+1 more");
    expect(reminder?.textContent).not.toContain("Reminders scheduled:");
    expect(reminder?.textContent).not.toContain("The Magnolia");
    expect(container.querySelector('[data-attr="payments-cluster-scheduled"]')).toBeNull();
    expect(container.querySelector('[data-attr="payment-list-row"]')?.textContent).toContain("Aug 28, 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same card row when embedded in a resident profile", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        onAddPayment={() => undefined}
      />,
    );

    expect(container.querySelector('[data-slot="data-list"]')).toBeNull();
    const row = container.querySelector('[data-attr="payment-list-row"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("July rent");
    expect(container.textContent).toContain("$1,850.00");
  });

  it("colours a paid charge's amount green", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow({ bucket: "paid", statusLabel: "Paid", balanceDue: "$0.00", amountPaid: "$1,850.00" })]}
        managerUserId="mgr-test"
        activeBucket="paid"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    const amount = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "$1,850.00" && el.className.includes("status-confirmed-fg"),
    );
    expect(amount).toBeTruthy();
  });

  it("never renders a second labeled Add here — the page band's icon action is the one way to add, empty or populated", () => {
    const { unmount } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /Add charge/i })).toBeNull();
    unmount();
    render(
      <ManagerPaymentsLedgerPanel
        rows={[]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );
    // The empty card deliberately keeps only its title — the band's
    // `PortalPrimaryIconAction` ("Add charge" in pro-payments.tsx) is the add
    // affordance now, not a labeled button inside this panel.
    expect(screen.queryByRole("button", { name: /Add charge/i })).toBeNull();
    expect(screen.getByText("No charges yet")).toBeInTheDocument();
  });

  it("renders action menus on grouped charge rows", () => {
    render(
      <ManagerPaymentsLedgerPanel
        rows={[
          sampleRow({ id: "hc_a", chargeTitle: "Move-in cost" }),
          sampleRow({ id: "hc_b", chargeTitle: "July rent" }),
        ]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Actions for/ }).length).toBe(2);
  });

  it("offers actions for a charge from its menu", async () => {
    render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /^Actions for/ }), { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: /Mark as paid/i })).toBeTruthy();
    // The boxed reminder lead that opened the scheduled-reminders sheet is
    // gone, so the ⋯ carries the way in.
    expect(screen.getByRole("menuitem", { name: /Scheduled reminders/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Delete$/i })).toBeTruthy();
    expect(document.querySelector('[data-slot="bulk-action-bar"]')).toBeNull();
  });

  it("keeps the opened record’s actions when the same charge ids reorder", async () => {
    const first = sampleRow({ id: "hc_a", chargeTitle: "Move-in cost" });
    const second = sampleRow({
      id: "hc_b",
      chargeTitle: "July rent",
      residentName: "Jordan Lee",
      residentEmail: "jordan@example.com",
    });
    const { rerender } = render(
      <ManagerPaymentsLedgerPanel
        rows={[first, second]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );

    fireEvent.keyDown(screen.getAllByRole("button", { name: /^Actions for/ })[0]!, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: /Mark as paid/i })).toBeTruthy();

    rerender(
      <ManagerPaymentsLedgerPanel
        rows={[second, first]}
        managerUserId="mgr-test"
        activeBucket="pending"
        direction="incoming"
        onAddPayment={() => undefined}
      />,
    );
    expect(screen.getByRole("menuitem", { name: /Mark as paid/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Delete$/i })).toBeTruthy();
  });

  it("renders a dashed list add row when embedded in resident", () => {
    render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        onAddPayment={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /Add payment/i })).toBeTruthy();
  });

  it("opens embedded charge detail via the card row", () => {
    const { container } = render(
      <ManagerPaymentsLedgerPanel
        rows={[sampleRow()]}
        managerUserId="mgr-test"
        activeBucket="pending"
        embeddedInResident
        buildPaymentDetailHref={(row) => `/portal/residents/approved/r1/payments/pending/${row.id}`}
      />,
    );

    const recordButton = container.querySelector('button[data-attr="payment-list-row"]');
    expect(recordButton).toBeTruthy();
    fireEvent.click(recordButton!);
    expect(navigate).toHaveBeenCalledWith("/portal/residents/approved/r1/payments/pending/hc_test_1");
  });
});
