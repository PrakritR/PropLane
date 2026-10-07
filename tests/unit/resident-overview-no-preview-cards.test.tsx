// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { ResidentOverviewPanel } from "@/components/portal/pro-resident-overview-panel";
import { residentBalanceStrip } from "@/components/portal/resident-payments-balance-strip";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";

const ledgerRow = (over: Partial<DemoManagerPaymentLedgerRow>): DemoManagerPaymentLedgerRow => ({
  id: "c1",
  propertyName: "House",
  roomNumber: "1",
  residentName: "Jordan",
  chargeTitle: "Rent",
  lineAmount: "$1,150.00",
  amountPaid: "$0.00",
  balanceDue: "$1,150.00",
  dueDate: "2026-10-25",
  dueDateSortMs: Date.UTC(2026, 9, 25),
  bucket: "pending",
  statusLabel: "Pending",
  notes: "",
  ...over,
});

describe("resident Overview", () => {
  it("renders no Tours / Lease / Payments / Services preview cards", () => {
    const html = renderToStaticMarkup(
      <ResidentOverviewPanel
        resident={{
          name: "Jordan Rivera",
          email: "jordan@example.com",
          propertyLabel: "61 Willow Court",
          roomLabel: "Room 3",
          signedMonthlyRent: 1150,
          leaseStart: "2026-11-01",
          leaseEnd: "2027-10-31",
          stage: "current",
          statusLabel: "Current",
          axisId: "AXIS-1",
        }}
        ledgerRows={[ledgerRow({}), ledgerRow({ id: "c2", bucket: "overdue" })]}
        leaseRows={[]}
        links={{ tours: "/t", lease: "/l", payments: "/p", services: "/s" }}
      />,
    );
    expect(html).not.toMatch(/data-rt-prev/);
    expect(html).not.toMatch(/View all/i);
    expect(html).not.toMatch(/resident-preview-view-all/);
    expect(html).toContain("data-rt-details");
  });

  it("source keeps no preview-card code or services prop", () => {
    const src = readFileSync("src/components/portal/pro-resident-overview-panel.tsx", "utf8");
    expect(src).not.toMatch(/PreviewCard|ResidentOverviewServiceItem|rt-prevs/);
  });
});

describe("residentBalanceStrip", () => {
  it("derives balance, next payment and paid-this-year from the ledger", () => {
    const strip = residentBalanceStrip(
      [
        ledgerRow({}),
        ledgerRow({ id: "p", bucket: "paid", amountPaid: "$40.00", balanceDue: "$0.00", dueDateSortMs: Date.UTC(2026, 5, 1) }),
      ],
      new Date(Date.UTC(2026, 9, 7)),
    );
    expect(strip.balance).toBe("$1,150.00");
    expect(strip.paidThisYear).toBe("$40.00");
    expect(strip.nextPayment).toContain("$1,150.00");
    expect(strip.overdue).toBe(false);
  });
});
