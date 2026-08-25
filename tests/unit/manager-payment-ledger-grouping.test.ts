import { describe, expect, it } from "vitest";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import {
  clusterManagerPaymentLedgerRows,
  paymentLedgerResidentLabel,
  residentPaymentLedgerGroupKey,
} from "@/lib/manager-payment-ledger-grouping";

function row(
  overrides: Partial<DemoManagerPaymentLedgerRow> & Pick<DemoManagerPaymentLedgerRow, "id">,
): DemoManagerPaymentLedgerRow {
  return {
    propertyName: "5257 Brooklyn Ave NE",
    roomNumber: "—",
    residentName: "Alex Kim",
    residentEmail: "alex@example.com",
    chargeTitle: "Rent",
    lineAmount: "$800.00",
    amountPaid: "$0.00",
    balanceDue: "$800.00",
    dueDate: "Sep 1, 2026",
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    ...overrides,
  };
}

describe("manager payment ledger grouping", () => {
  it("groups charges for the same resident email together", () => {
    const clusters = clusterManagerPaymentLedgerRows([
      row({ id: "a", chargeTitle: "Move-in cost" }),
      row({ id: "b", chargeTitle: "Rent — September 2026" }),
      row({
        id: "c",
        residentName: "Morgan Lee",
        residentEmail: "morgan@example.com",
        chargeTitle: "Application fee",
      }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(clusters[1]?.rows.map((r) => r.id)).toEqual(["c"]);
  });

  it("preserves first-seen resident order", () => {
    const clusters = clusterManagerPaymentLedgerRows([
      row({ id: "1", residentName: "Zoe", residentEmail: "zoe@example.com" }),
      row({ id: "2", residentName: "Amy", residentEmail: "amy@example.com" }),
      row({ id: "3", residentName: "Zoe", residentEmail: "zoe@example.com", chargeTitle: "Utilities" }),
    ]);

    expect(clusters.map((c) => c.residentLabel)).toEqual(["Zoe", "Amy"]);
    expect(clusters[0]?.rows).toHaveLength(2);
  });

  it("uses email as the stable group key", () => {
    const first = row({ id: "1", residentName: "Alex Kim", residentEmail: "alex@example.com" });
    const second = row({ id: "2", residentName: "A. Kim", residentEmail: "alex@example.com" });
    expect(residentPaymentLedgerGroupKey(first)).toBe(residentPaymentLedgerGroupKey(second));
  });

  it("falls back to resident name then row id", () => {
    expect(
      paymentLedgerResidentLabel({ residentName: "", residentEmail: "alex@example.com" }),
    ).toBe("alex@example.com");
    expect(
      paymentLedgerResidentLabel({ residentName: "Alex Kim", residentEmail: "" }),
    ).toBe("Alex Kim");
    expect(
      residentPaymentLedgerGroupKey({ id: "hc_only", residentName: "", residentEmail: "" }),
    ).toBe("id:hc_only");
  });

  it("records a shared property label only when every charge matches", () => {
    const clusters = clusterManagerPaymentLedgerRows([
      row({ id: "a", propertyName: "House A" }),
      row({ id: "b", propertyName: "House A" }),
      row({ id: "c", propertyName: "House B", residentEmail: "other@example.com", residentName: "Other" }),
    ]);

    expect(clusters[0]?.propertyLabel).toBe("House A");
    expect(clusters[1]?.propertyLabel).toBe("House B");
  });
});
