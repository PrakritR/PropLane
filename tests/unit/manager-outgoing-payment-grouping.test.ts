import { describe, expect, it } from "vitest";
import { clusterManagerOutgoingPaymentRowsByMode } from "@/lib/manager-outgoing-payment-grouping";
import type { DemoManagerOutgoingPaymentRow } from "@/data/demo-portal";

function row(
  over: Partial<DemoManagerOutgoingPaymentRow> & Pick<DemoManagerOutgoingPaymentRow, "id" | "chargeTitle">,
): DemoManagerOutgoingPaymentRow {
  return {
    propertyName: "Ballard House",
    propertyId: "prop-ballard",
    categoryLabel: "Expense",
    payeeLabel: "Mason Clark",
    amountLabel: "$44.99",
    dueDate: "Aug 1, 2026",
    bucket: "paid",
    statusLabel: "Paid",
    ...over,
  };
}

describe("manager-outgoing-payment-grouping", () => {
  it("clusters outgoing payments by payee in resident mode", () => {
    const clusters = clusterManagerOutgoingPaymentRowsByMode(
      [
        row({ id: "a", chargeTitle: "Background check", payeeLabel: "Marcus Chen", propertyName: "Portfolio" }),
        row({ id: "b", chargeTitle: "Screening fee", payeeLabel: "Marcus Chen", propertyName: "Portfolio" }),
        row({ id: "c", chargeTitle: "Move-in", payeeLabel: "Sofia Diaz" }),
      ],
      "resident",
    );
    expect(clusters).toHaveLength(2);
    const marcus = clusters.find((c) => c.residentLabel === "Marcus Chen");
    expect(marcus?.rows).toHaveLength(2);
  });

  it("clusters outgoing payments by property in house mode", () => {
    const clusters = clusterManagerOutgoingPaymentRowsByMode(
      [
        row({ id: "a", chargeTitle: "Background check — Mason", payeeLabel: "Mason Clark" }),
        row({ id: "b", chargeTitle: "Background check — Sofia", payeeLabel: "Sofia Diaz" }),
        row({
          id: "c",
          chargeTitle: "Mini-split cleaning",
          payeeLabel: "Vendor",
          propertyName: "Lakeview Studio",
          propertyId: "prop-lake",
        }),
      ],
      "house",
    );
    expect(clusters).toHaveLength(2);
    const ballard = clusters.find((c) => c.propertyLabel === "Ballard House");
    expect(ballard?.rows).toHaveLength(2);
    const lakeview = clusters.find((c) => c.propertyLabel === "Lakeview Studio");
    expect(lakeview?.rows).toHaveLength(1);
  });
});
