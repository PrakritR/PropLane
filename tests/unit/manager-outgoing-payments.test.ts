// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildManagerOutgoingPaymentRows,
  deleteManagerOutgoingExpense,
  readManagerOutgoingExpenses,
  syncManagerOutgoingExpensesFromServer,
} from "@/lib/manager-outgoing-payments";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: vi.fn(() => false),
}));

describe("buildManagerOutgoingPaymentRows", () => {
  it("includes pending vendor work orders and paid expenses", () => {
    const workOrders: DemoManagerWorkOrderRow[] = [
      {
        id: "wo-1",
        propertyName: "Magnolia House",
        unit: "Room 1",
        title: "Sink repair",
        priority: "Medium",
        status: "Completed",
        bucket: "completed",
        description: "",
        scheduled: "—",
        cost: "$200.00",
        vendorName: "Rainier Plumbing",
        vendorCostCents: 20000,
        automationStatus: "vendor_marked_done",
        vendorMarkedDoneAt: new Date().toISOString(),
      },
    ];

    const rows = buildManagerOutgoingPaymentRows({
      managerUserId: "mgr-1",
      expenses: [
        {
          id: "exp-1",
          categoryCode: "property_tax",
          categoryLabel: "Property Tax",
          amountCents: 120000,
          expenseDate: "2026-06-01",
          memo: "Q2 property tax",
          propertyName: "Magnolia House",
        },
      ],
      workOrders,
    });

    expect(rows.some((row) => row.id === "work-order-wo-1" && row.bucket === "pending")).toBe(true);
    expect(rows.some((row) => row.id === "expense-exp-1" && row.bucket === "paid")).toBe(true);
  });

  it("shows paid-via channel on expense rows linked to a paid work order", () => {
    const workOrders: DemoManagerWorkOrderRow[] = [
      {
        id: "wo-paid",
        propertyName: "Magnolia House",
        unit: "Room 1",
        title: "Sink repair",
        priority: "Medium",
        status: "Completed",
        bucket: "completed",
        description: "",
        scheduled: "—",
        cost: "$200.00",
        vendorName: "Rainier Plumbing",
        vendorId: "vendor-1",
        vendorCostCents: 20000,
        automationStatus: "paid",
        paidAt: "2026-06-02T12:00:00.000Z",
        vendorPaymentChannel: "zelle",
      },
    ];

    const rows = buildManagerOutgoingPaymentRows({
      managerUserId: "mgr-1",
      expenses: [
        {
          id: "exp-wo",
          categoryCode: "vendor_payment",
          categoryLabel: "Vendor payment",
          amountCents: 20000,
          expenseDate: "2026-06-02",
          memo: "Sink repair",
          propertyName: "Magnolia House",
          sourceWorkOrderId: "wo-paid",
          vendorId: "vendor-1",
        },
      ],
      workOrders,
    });

    const expenseRow = rows.find((row) => row.id === "expense-exp-wo");
    expect(expenseRow?.paidViaChannel).toBe("zelle");
    expect(expenseRow?.statusLabel).toBe("Paid · Zelle");
    expect(rows.some((row) => row.id === "work-order-paid-wo-paid")).toBe(false);
  });
});

describe("deleteManagerOutgoingExpense", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("removes a locally cached expense", async () => {
    window.sessionStorage.setItem(
      "axis:manager-outgoing-expenses:v1",
      JSON.stringify([
        {
          id: "exp-local",
          categoryCode: "other_expense",
          categoryLabel: "Other",
          amountCents: 1000,
          expenseDate: "2026-06-01",
        },
      ]),
    );

    expect(deleteManagerOutgoingExpense("exp-local")).toBe(true);
    expect(readManagerOutgoingExpenses().some((row) => row.id === "exp-local")).toBe(false);
  });

  it("does not rehydrate deleted demo expenses on sync", async () => {
    const { isDemoModeActive } = await import("@/lib/demo/demo-session");
    vi.mocked(isDemoModeActive).mockReturnValue(true);

    window.sessionStorage.setItem(
      "axis:manager-outgoing-expenses:v1",
      JSON.stringify([
        {
          id: "demo-exp-6",
          categoryCode: "other_expense",
          categoryLabel: "Other",
          amountCents: 1000,
          expenseDate: "2026-06-01",
        },
      ]),
    );

    await syncManagerOutgoingExpensesFromServer(true);
    expect(readManagerOutgoingExpenses().some((row) => row.id === "demo-exp-6")).toBe(true);

    expect(deleteManagerOutgoingExpense("demo-exp-6")).toBe(true);
    expect(readManagerOutgoingExpenses().some((row) => row.id === "demo-exp-6")).toBe(false);

    await syncManagerOutgoingExpensesFromServer(true);
    expect(readManagerOutgoingExpenses().some((row) => row.id === "demo-exp-6")).toBe(false);

    vi.mocked(isDemoModeActive).mockReturnValue(false);
  });
});
