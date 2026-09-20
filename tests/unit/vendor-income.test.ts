import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  buildVendorIncomeRow,
  buildVendorIncomeRows,
  buildVendorPropertyFilterOptions,
  filterVendorIncomeRows,
  vendorIncomeEligible,
  vendorIncomeTotals,
  vendorWorkOrderIncomeCents,
} from "@/lib/vendor-income";
import type { VendorPayout } from "@/lib/vendor-payouts";

function workOrder(extra: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "The Pioneer",
    unit: "12A",
    title: "HVAC tune-up",
    priority: "Medium",
    status: "Completed",
    bucket: "completed",
    description: "",
    scheduled: "",
    cost: "",
    propertyId: "prop-pioneer",
    ...extra,
  };
}

describe("vendor income", () => {
  it("includes completed work orders marked done or paid", () => {
    expect(vendorIncomeEligible(workOrder({ automationStatus: "paid" }))).toBe(true);
    expect(vendorIncomeEligible(workOrder({ automationStatus: "vendor_marked_done" }))).toBe(true);
    expect(vendorIncomeEligible(workOrder({ bucket: "open" }))).toBe(false);
  });

  it("resolves income cents from labor, materials, payout, and cost string", () => {
    const payout: VendorPayout = {
      id: "p1",
      workOrderId: "wo-1",
      amountCents: 12_500,
      stripeTransferId: "tr_1",
      status: "paid",
      failureReason: null,
      createdAt: "2026-01-10T12:00:00.000Z",
    };

    expect(
      vendorWorkOrderIncomeCents(
        workOrder({ vendorCostCents: 28_500, materialsCostCents: 4_500 }),
        payout,
      ),
    ).toBe(33_000);

    expect(vendorWorkOrderIncomeCents(workOrder({ cost: "$175.00" }), undefined)).toBe(17_500);
    expect(vendorWorkOrderIncomeCents(workOrder(), payout)).toBe(12_500);
  });

  it("builds income rows and filters by date and property", () => {
    const rows = buildVendorIncomeRows(
      [
        workOrder({
          id: "wo-paid",
          automationStatus: "paid",
          vendorCostCents: 28_500,
          materialsCostCents: 4_500,
          paidAt: "2026-03-15T10:00:00.000Z",
          propertyId: "prop-a",
        }),
        workOrder({
          id: "wo-pending",
          title: "Leak repair",
          automationStatus: "vendor_marked_done",
          vendorCostCents: 17_500,
          vendorMarkedDoneAt: "2026-02-01T10:00:00.000Z",
          propertyId: "prop-b",
        }),
      ],
      {},
    );

    expect(rows).toHaveLength(2);
    expect(buildVendorPropertyFilterOptions(rows).map((p) => p.id).sort()).toEqual(["prop-a", "prop-b"]);

    const filtered = filterVendorIncomeRows(rows, {
      from: "2026-03-01",
      to: "2026-03-31",
      propertyId: "",
    });
    expect(filtered.map((r) => r.id)).toEqual(["wo-paid"]);

    const row = buildVendorIncomeRow(
      workOrder({
        automationStatus: "paid",
        vendorCostCents: 10_000,
        paidAt: "2026-04-01T10:00:00.000Z",
      }),
      {
        id: "p1",
        workOrderId: "wo-1",
        amountCents: 10_000,
        stripeTransferId: null,
        status: "failed",
        failureReason: "Connect onboarding incomplete",
        createdAt: "2026-04-02T10:00:00.000Z",
      },
    );
    expect(row?.payoutStatusLabel).toBe("Payout failed");
    expect(vendorIncomeTotals(filtered).totalCents).toBe(33_000);

    expect(
      filterVendorIncomeRows(rows, {
        from: "2026-01-01",
        to: "2026-12-31",
        propertyIds: ["prop-b"],
      }).map((r) => r.id),
    ).toEqual(["wo-pending"]);

    expect(
      filterVendorIncomeRows(rows, {
        from: "2026-01-01",
        to: "2026-12-31",
        query: "leak",
      }).map((r) => r.id),
    ).toEqual(["wo-pending"]);
  });
});
