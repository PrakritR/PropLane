import { describe, expect, it } from "vitest";
import { reportToCsv } from "@/lib/reports/export/csv";
import {
  buildProfitabilityReport,
  commsBillableCentsByMonth,
  defaultIncomeClass,
  managerBorneFeeCents,
  profitabilityMonthKeys,
  PROFITABILITY_UNASSIGNED_LABEL,
  type ProfitabilityInput,
} from "@/lib/reports/profitability";

const labels: Record<string, string> = { "prop-a": "12 Alder St", "prop-b": "9 Birch Ave" };

function fixture(overrides: Partial<ProfitabilityInput> = {}): ProfitabilityInput {
  return {
    from: "2026-07-01",
    to: "2026-08-31",
    groupBy: "property",
    ledgerPayments: [
      // July, Alder: rent, resident paid the service fee (net == amount → 0 fee).
      { propertyId: "prop-a", postedDate: "2026-07-03", categoryCode: "rent_income", amountCents: 200_000, stripeFeeCents: 0, netCents: 200_000 },
      // August, Alder: rent, MANAGER absorbed the fee (transfer short by $6.10).
      { propertyId: "prop-a", postedDate: "2026-08-02", categoryCode: "rent_income", amountCents: 200_000, stripeFeeCents: 0, netCents: 199_390 },
      // August, Alder: late fee → other income; not yet enriched by Stripe.
      { propertyId: "prop-a", postedDate: "2026-08-10", categoryCode: "late_fees", amountCents: 5_000, stripeFeeCents: null, netCents: null },
      // July, Birch: rent.
      { propertyId: "prop-b", postedDate: "2026-07-05", categoryCode: "rent_income", amountCents: 150_000, stripeFeeCents: 0, netCents: 150_000 },
      // July, Birch: security deposit — a liability, never income.
      { propertyId: "prop-b", postedDate: "2026-07-05", categoryCode: "security_deposit_liability", amountCents: 150_000, stripeFeeCents: 0, netCents: 150_000 },
      // Out of range: ignored.
      { propertyId: "prop-b", postedDate: "2026-06-30", categoryCode: "rent_income", amountCents: 999_999, stripeFeeCents: 0, netCents: 999_999 },
    ],
    expenses: [
      { propertyId: "prop-a", expenseDate: "2026-07-15", amountCents: 30_000 },
      { propertyId: "prop-b", expenseDate: "2026-08-20", amountCents: 12_500 },
      { propertyId: null, expenseDate: "2026-08-21", amountCents: 1_000 },
    ],
    vendorPayouts: [
      { propertyId: "prop-a", paidAt: "2026-08-12T17:30:00.000Z", amountCents: 45_000 },
      { propertyId: null, paidAt: "2026-07-01T00:00:00.000Z", amountCents: 8_000 },
    ],
    commsUsage: [
      // July: $2.00 used — within the Free allowance ($2.50).
      { createdAt: "2026-07-04T10:00:00.000Z", totalCents: 200 },
      // August: $3.00 + $1.00 used — $1.50 above the allowance is billable.
      { createdAt: "2026-08-04T10:00:00.000Z", totalCents: 300 },
      { createdAt: "2026-08-20T10:00:00.000Z", totalCents: 100 },
    ],
    commsAllowance: { readable: true, cents: 250 },
    propertyLabel: (id) => labels[id] ?? id,
    ...overrides,
  };
}

function rowFor(rows: Record<string, unknown>[], property: string, month?: string) {
  const row = rows.find((r) => r.property === property && (month === undefined || r.month === month));
  if (!row) throw new Error(`missing row ${property} ${month ?? ""}`);
  return row;
}

describe("profitability aggregation", () => {
  it("derives the month keys from the range", () => {
    expect(profitabilityMonthKeys("2026-11-15", "2027-02-03")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(profitabilityMonthKeys("2026-03-01", "2026-03-31")).toEqual(["2026-03"]);
    expect(profitabilityMonthKeys("2026-04-01", "2026-03-01")).toEqual([]);
  });

  it("classifies income by chart account: rent, other income, liabilities excluded", () => {
    expect(defaultIncomeClass("rent_income")).toBe("rent");
    expect(defaultIncomeClass("late_fees")).toBe("other");
    expect(defaultIncomeClass("other_income")).toBe("other");
    expect(defaultIncomeClass("security_deposit_liability")).toBe("excluded");
  });

  it("counts only the fee the manager bore — never the resident's", () => {
    // Resident paid: the transfer equals the charge.
    expect(managerBorneFeeCents({ amountCents: 100_000, stripeFeeCents: 0, netCents: 100_000 })).toBe(0);
    // Manager absorbed: the transfer is short by the fee.
    expect(managerBorneFeeCents({ amountCents: 100_000, stripeFeeCents: 0, netCents: 97_100 })).toBe(2_900);
    // A Stripe fee debited from the manager adds on top.
    expect(managerBorneFeeCents({ amountCents: 100_000, stripeFeeCents: 300, netCents: 97_100 })).toBe(3_200);
    // Not enriched yet: no evidence, so 0 rather than a guess.
    expect(managerBorneFeeCents({ amountCents: 100_000, stripeFeeCents: null, netCents: null })).toBe(0);
    // A net above the charge (partial refund oddities) never goes negative.
    expect(managerBorneFeeCents({ amountCents: 100_000, stripeFeeCents: 0, netCents: 100_500 })).toBe(0);
  });

  it("bills communication only above the allowance, per month", () => {
    const months = ["2026-07", "2026-08", "2026-09"];
    const out = commsBillableCentsByMonth(fixture().commsUsage, months, { readable: true, cents: 250 });
    expect([...out.entries()]).toEqual([
      ["2026-07", 0],
      ["2026-08", 150],
      ["2026-09", 0],
    ]);
    // Unreadable plan or uncapped plan: nothing billable can be derived.
    expect([...commsBillableCentsByMonth(fixture().commsUsage, months, { readable: false }).values()]).toEqual([0, 0, 0]);
    expect([...commsBillableCentsByMonth(fixture().commsUsage, months, { readable: true, cents: null }).values()]).toEqual([0, 0, 0]);
  });

  it("sums per property over the range with a totals row and net math", () => {
    const { report, months, propertyCount } = buildProfitabilityReport(fixture());
    expect(months).toEqual(["2026-07", "2026-08"]);
    expect(propertyCount).toBe(2);
    expect(report.columns.map((c) => c.key)).toEqual([
      "property",
      "grossRent",
      "otherIncome",
      "processingFees",
      "vendorPayouts",
      "commsCost",
      "expenses",
      "net",
    ]);
    // Sorted by label, unassigned last.
    expect(report.rows.map((r) => r.property)).toEqual(["12 Alder St", "9 Birch Ave", PROFITABILITY_UNASSIGNED_LABEL]);

    const alder = rowFor(report.rows, "12 Alder St");
    expect(alder).toMatchObject({
      propertyId: "prop-a",
      grossRent: "$4000.00",
      otherIncome: "$50.00",
      processingFees: "$6.10",
      vendorPayouts: "$450.00",
      commsCost: "$0.00",
      expenses: "$300.00",
      // 4000 + 50 − 6.10 − 450 − 0 − 300
      net: "$3293.90",
    });

    const birch = rowFor(report.rows, "9 Birch Ave");
    expect(birch).toMatchObject({
      grossRent: "$1500.00",
      otherIncome: "$0.00", // the deposit is excluded
      processingFees: "$0.00",
      vendorPayouts: "$0.00",
      expenses: "$125.00",
      net: "$1375.00",
    });

    const unassigned = rowFor(report.rows, PROFITABILITY_UNASSIGNED_LABEL);
    expect(unassigned).toMatchObject({
      propertyId: "",
      grossRent: "$0.00",
      vendorPayouts: "$80.00",
      commsCost: "$1.50",
      expenses: "$10.00",
      net: "-$91.50",
    });

    expect(report.totals).toMatchObject({
      property: "Total",
      grossRent: "$5500.00",
      otherIncome: "$50.00",
      processingFees: "$6.10",
      vendorPayouts: "$530.00",
      commsCost: "$1.50",
      expenses: "$435.00",
      net: "$4577.40",
    });
    expect(report.meta).toMatchObject({ from: "2026-07-01", to: "2026-08-31", groupBy: "property", months: 2, propertyCount: 2 });
  });

  it("breaks out per property per month when grouped by month, newest first", () => {
    const { report } = buildProfitabilityReport(fixture({ groupBy: "month" }));
    expect(report.columns[0]).toMatchObject({ key: "month", label: "Month" });
    expect(report.rows.map((r) => [r.month, r.property])).toEqual([
      ["Aug 2026", "12 Alder St"],
      ["Aug 2026", "9 Birch Ave"],
      ["Aug 2026", PROFITABILITY_UNASSIGNED_LABEL],
      ["Jul 2026", "12 Alder St"],
      ["Jul 2026", "9 Birch Ave"],
      ["Jul 2026", PROFITABILITY_UNASSIGNED_LABEL],
    ]);
    expect(rowFor(report.rows, "12 Alder St", "Jul 2026")).toMatchObject({
      monthKey: "2026-07",
      grossRent: "$2000.00",
      processingFees: "$0.00",
      expenses: "$300.00",
      net: "$1700.00",
    });
    expect(rowFor(report.rows, "12 Alder St", "Aug 2026")).toMatchObject({
      grossRent: "$2000.00",
      otherIncome: "$50.00",
      processingFees: "$6.10",
      vendorPayouts: "$450.00",
      net: "$1593.90",
    });
    expect(rowFor(report.rows, PROFITABILITY_UNASSIGNED_LABEL, "Jul 2026")).toMatchObject({ commsCost: "$0.00", vendorPayouts: "$80.00" });
    expect(rowFor(report.rows, PROFITABILITY_UNASSIGNED_LABEL, "Aug 2026")).toMatchObject({ commsCost: "$1.50", expenses: "$10.00" });
    expect(report.totals).toMatchObject({ month: "Total", net: "$4577.40" });
  });

  it("reports a category with no source as 0 and says why", () => {
    const unreadable = buildProfitabilityReport(fixture({ commsAllowance: { readable: false } }));
    expect(unreadable.report.totals?.commsCost).toBe("$0.00");
    expect(String(unreadable.report.meta?.source_commsCost)).toMatch(/plan could not be read/);
    expect(unreadable.sources.commsCost).toMatch(/^0 —/);

    const scoped = buildProfitabilityReport(fixture({ propertyFilterActive: true }));
    expect(scoped.report.totals?.commsCost).toBe("$0.00");
    expect(String(scoped.report.meta?.source_commsCost)).toMatch(/portfolio-wide/);

    const empty = buildProfitabilityReport(
      fixture({ ledgerPayments: [], expenses: [], vendorPayouts: [], commsUsage: [] }),
    );
    expect(empty.report.rows).toEqual([]);
    expect(empty.propertyCount).toBe(0);
    expect(empty.report.totals?.net).toBe("$0.00");
    for (const key of ["source_grossRent", "source_otherIncome", "source_processingFees", "source_vendorPayouts", "source_expenses"]) {
      expect(String(empty.report.meta?.[key])).not.toBe("");
    }
  });

  it("never lets a negative or malformed amount inflate a column", () => {
    const { report } = buildProfitabilityReport(
      fixture({
        ledgerPayments: [
          { propertyId: "prop-a", postedDate: "2026-07-03", categoryCode: "rent_income", amountCents: Number.NaN, stripeFeeCents: null, netCents: null },
          { propertyId: "prop-a", postedDate: "not-a-date", categoryCode: "rent_income", amountCents: 100, stripeFeeCents: 0, netCents: 100 },
        ],
        expenses: [{ propertyId: "prop-a", expenseDate: "2026-07-03", amountCents: -500 }],
        vendorPayouts: [],
        commsUsage: [],
      }),
    );
    expect(report.rows).toEqual([]);
  });
});

describe("profitability CSV", () => {
  it("serialises the table columns plus the totals row through the shared CSV path", () => {
    const { report } = buildProfitabilityReport(
      fixture({ propertyLabel: (id) => (id === "prop-a" ? 'Alder "North", Unit 2' : labels[id] ?? id) }),
    );
    const csv = reportToCsv(report);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Property,Gross rent,Other income,Processing fees,Vendor payouts,Communication,Expenses,Net");
    // Identifier keys (propertyId, monthKey) are not columns, so they never reach the file.
    expect(csv).not.toContain("prop-a");
    // RFC 4180 quoting for a label carrying quotes and a comma. Asserted by
    // CONTENT, not by row number: rows sort by property label, and renaming
    // prop-a to "Alder …" moves it behind "9 Birch Ave" (digit before letter).
    expect(lines).toContain('"Alder ""North"", Unit 2",$4000.00,$50.00,$6.10,$450.00,$0.00,$300.00,$3293.90');
    expect(lines[1]).toMatch(/^9 Birch Ave,/);
    expect(lines[lines.length - 1]).toBe("Total,$5500.00,$50.00,$6.10,$530.00,$1.50,$435.00,$4577.40");
    expect(lines).toHaveLength(1 + report.rows.length + 1);
  });

  it("adds the Month column when grouped by month", () => {
    const { report } = buildProfitabilityReport(fixture({ groupBy: "month" }));
    const lines = reportToCsv(report).split("\n");
    expect(lines[0]).toMatch(/^Month,Property,Gross rent/);
    expect(lines[1]).toMatch(/^Aug 2026,12 Alder St,\$2000\.00/);
    expect(lines[lines.length - 1]).toMatch(/^Total,,\$5500\.00/);
  });
});
