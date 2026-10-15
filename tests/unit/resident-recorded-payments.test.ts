import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { ReportRow } from "@/lib/reports/types";
import { buildReceiptRows } from "@/lib/rent-receipts";
import {
  formatLedgerDateLabel,
  isRecordedPaymentRow,
  receiptRowLabel,
  recordedPaymentTitle,
  recordedPaymentsMissingFromCharges,
  residentLedgerReceiptRange,
} from "@/lib/resident-recorded-payments";
import { chargeDueLabel, compareChargesByDueDate } from "@/lib/household-charges";

/**
 * Resident audit F6 (Payments "Paid 0" vs eleven receipts in Documents) and U9
 * (utilities payments labelled "Rent receipt").
 */

const ledgerRows: ReportRow[] = [
  { date: "2026-06-14", description: "Payment — Application fee", charge: "", payment: "$45.00", balance: "$0.00", sourceChargeId: "hc_fee_1", property: "The Pioneer" },
  { date: "2026-07-02", description: "Payment — Utilities — July 2026", charge: "", payment: "$85.00", balance: "$0.00", sourceChargeId: "hc_util_1", property: "The Pioneer" },
  { date: "2026-07-02", description: "Rent — July 2026", charge: "$2400.00", payment: "", balance: "$2400.00", sourceChargeId: "hc_rent_1", property: "The Pioneer" },
];

function paidCharge(id: string): HouseholdCharge {
  return {
    id,
    createdAt: "2026-07-01",
    residentEmail: "r@example.com",
    residentName: "R",
    residentUserId: null,
    propertyId: "p",
    propertyLabel: "The Pioneer",
    managerUserId: "m",
    kind: "utilities",
    title: "Utilities",
    amountLabel: "$85.00",
    balanceLabel: "$0.00",
    status: "paid",
    blocksLeaseUntilPaid: false,
  } as HouseholdCharge;
}

describe("recordedPaymentTitle / receiptRowLabel (U9)", () => {
  it("names what was actually paid instead of assuming rent", () => {
    expect(recordedPaymentTitle("Payment — Utilities — July 2026")).toBe("Utilities — July 2026");
    expect(recordedPaymentTitle("Payment — Security deposit")).toBe("Security deposit");
    expect(receiptRowLabel("Payment — Utilities — July 2026")).toBe("Receipt · Utilities — July 2026");
    expect(receiptRowLabel("Payment — Move-in fee")).toBe("Receipt · Move-in fee");
  });

  it("never falls back to a rent label when the description is empty", () => {
    expect(recordedPaymentTitle("")).toBe("Payment");
    expect(receiptRowLabel(null)).toBe("Receipt · Payment");
    const rows = buildReceiptRows([{ date: "2026-07-02", description: "", payment: "$85.00" }]);
    expect(rows[0]!.description).toBe("Payment");
    expect(receiptRowLabel(rows[0]!.description)).not.toContain("Rent");
  });
});

describe("formatLedgerDateLabel — one date format in the Due column", () => {
  it("renders a plain posted_date the way live charges render their due date", () => {
    expect(formatLedgerDateLabel("2026-03-01")).toBe(
      new Date(2026, 2, 1, 12).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
    expect(formatLedgerDateLabel("2026-03-01")).not.toBe("2026-03-01");
  });

  it("passes anything it cannot read through untouched", () => {
    expect(formatLedgerDateLabel("")).toBe("");
    expect(formatLedgerDateLabel(null)).toBe("");
    expect(formatLedgerDateLabel("Before move-in")).toBe("Before move-in");
  });

  it("keeps a synthesized row on its own local calendar day, in any timezone", () => {
    const [row] = recordedPaymentsMissingFromCharges(
      [{ date: "2026-03-01", description: "Payment — Rent — March 2026", payment: "$100.00" }],
      [],
    );
    // The label the Paid tab prints, and the date the Paid tab sorts on, are
    // both March 1 — `new Date("2026-03-01")` is UTC midnight, which reads back
    // as Feb 28 west of UTC.
    expect(chargeDueLabel(row!)).toContain("2026");
    expect(chargeDueLabel(row!)).not.toBe("2026-03-01");
    const laterSameMonth = recordedPaymentsMissingFromCharges(
      [{ date: "2026-03-02", description: "Payment — Rent", payment: "$100.00" }],
      [],
    )[0]!;
    expect(compareChargesByDueDate(row!, laterSameMonth, "desc")).toBeGreaterThan(0);
    // The plain posted_date survives for matching.
    expect(row!.paidAt).toBe("2026-03-01");
  });
});

describe("recordedPaymentsMissingFromCharges (F6)", () => {
  it("surfaces a recorded payment whose charge row no longer exists", () => {
    const out = recordedPaymentsMissingFromCharges(ledgerRows, []);
    expect(out.map((c) => c.title)).toEqual(["Application fee", "Utilities — July 2026"]);
    expect(out.every((c) => c.status === "paid")).toBe(true);
    expect(out[0]!.amountLabel).toBe("$45.00");
    expect(out[0]!.paidAt).toBe("2026-06-14");
  });

  it("never duplicates a payment whose charge is still in the store", () => {
    const out = recordedPaymentsMissingFromCharges(ledgerRows, [paidCharge("hc_util_1")]);
    expect(out.map((c) => c.title)).toEqual(["Application fee"]);
  });

  it("ignores charge entries — only payments become receipts", () => {
    const chargesOnly = ledgerRows.filter((r) => !r.payment);
    expect(recordedPaymentsMissingFromCharges(chargesOnly, [])).toEqual([]);
  });

  it("keeps two genuinely identical payments distinct when neither carries a source id", () => {
    const twins: ReportRow[] = [
      { date: "2026-06-14", description: "Payment — Application fee", payment: "$45.00" },
      { date: "2026-06-14", description: "Payment — Application fee", payment: "$45.00" },
    ];
    expect(recordedPaymentsMissingFromCharges(twins, [])).toHaveLength(2);
  });

  it("gives a source-id-less payment the same id no matter where it sits in the ledger", () => {
    const twins: ReportRow[] = [
      { date: "2026-06-14", description: "Payment — Application fee", payment: "$45.00" },
      { date: "2026-06-14", description: "Payment — Application fee", payment: "$45.00" },
    ];
    const earlier: ReportRow = { date: "2026-05-01", description: "Payment — Rent — May 2026", payment: "$2400.00" };

    const before = recordedPaymentsMissingFromCharges(twins, []).map((c) => c.id);
    const after = recordedPaymentsMissingFromCharges([earlier, ...twins], []).map((c) => c.id);

    // A ledger row appearing ahead of them must not renumber their ids.
    expect(new Set(before).size).toBe(2);
    expect(after.slice(1)).toEqual(before);
  });

  it("marks every synthesized row as a recorded payment, and no real charge", () => {
    const out = recordedPaymentsMissingFromCharges(ledgerRows, []);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(isRecordedPaymentRow)).toBe(true);
    expect(isRecordedPaymentRow(paidCharge("hc_util_1"))).toBe(false);
  });

  it("Documents and Payments read the same ledger window", () => {
    const now = new Date(2026, 7, 3, 12, 0, 0);
    expect(residentLedgerReceiptRange(now)).toEqual({ from: "2025-08-03", to: "2026-08-03" });
  });

  it("builds the window from LOCAL calendar dates, not a UTC serialization", () => {
    // Late-evening local time east of UTC used to roll `to` (and `from`) onto
    // the next/previous UTC day, so a payment posted today could fall outside
    // the window on BOTH surfaces at once. posted_date is a plain date.
    const lateLocal = new Date(2026, 7, 3, 23, 30, 0);
    expect(residentLedgerReceiptRange(lateLocal)).toEqual({ from: "2025-08-03", to: "2026-08-03" });
    const earlyLocal = new Date(2026, 0, 1, 0, 15, 0);
    expect(residentLedgerReceiptRange(earlyLocal)).toEqual({ from: "2025-01-01", to: "2026-01-01" });
  });
});

describe("recorded payments are not links to a detail page", () => {
  /**
   * A synthesized row has no charge record behind it, so the resident charge
   * detail page — which looks the id up in the live charge list — renders
   * "Charge not found." for every one of them. The Paid list must therefore not
   * hand those rows an `onClick`.
   */
  it("gates the Paid row click on isRecordedPaymentRow", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/portal/resident-payments-panel.tsx"),
      "utf8",
    );
    // Every navigation to the charge detail page must sit on the non-recorded
    // branch of that guard — an unguarded one is the dead link this covers.
    // (A `?pay=<chargeId>` deep link also routes to a record, with `{ replace: true }` - not a row click.)
    const navigations = (src.match(/[^\n]*portalNavigate\(residentChargeDetailHref\([^\n]*/g) ?? []).filter((line) => !line.includes("replace: true"));
    expect(navigations).toHaveLength(1);
    expect(src).toMatch(
      /onClick: isRecordedPaymentRow\(row\)\s*\?\s*undefined\s*:\s*\(\) => portalNavigate\(residentChargeDetailHref\(/,
    );
  });
});
