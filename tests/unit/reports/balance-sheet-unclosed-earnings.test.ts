import { describe, expect, it } from "vitest";
import { queryBalanceSheet } from "@/lib/reports/queries/gl-reports";

type Line = { account_code: string; debit_cents: number; credit_cents: number };
type Entry = { manager_user_id: string; property_id: string; entry_date: string; is_reversal: boolean;
  gl_journal_lines: Line[] };

function journal(owner: string, property: string, day: string, lines: Line[]): Entry {
  return { manager_user_id: owner, property_id: property, entry_date: day, is_reversal: false,
    gl_journal_lines: lines };
}

function fakeDb(entries: Entry[]) {
  return {
    from(table: string) {
      if (table === "chart_of_accounts") {
        const chart = {
          select: () => chart, order: () => chart, is: () => chart,
          then: (resolve: (value: { data: null; error: { message: string } }) => void) =>
            resolve({ data: null, error: { message: "use bundled chart fallback" } }),
        };
        return chart;
      }
      if (table !== "gl_journal_entries") throw new Error("Unexpected report source");
      let matching = entries;
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          matching = matching.filter(row => (row as unknown as Record<string, unknown>)[key] === value);
          return query;
        },
        lte: (key: string, value: string) => {
          matching = matching.filter(row => String((row as unknown as Record<string, unknown>)[key]) <= value);
          return query;
        },
        in: (key: string, values: string[]) => {
          matching = matching.filter(row => values.includes(String((row as unknown as Record<string, unknown>)[key])));
          return query;
        },
        order: () => query,
        limit: () => query,
        then: (resolve: (value: { data: Entry[]; error: null }) => void) =>
          resolve({ data: matching, error: null }),
      };
      return query;
    },
  } as never;
}

const debit = (account_code: string, debit_cents: number): Line =>
  ({ account_code, debit_cents, credit_cents: 0 });
const credit = (account_code: string, credit_cents: number): Line =>
  ({ account_code, debit_cents: 0, credit_cents });

describe("Balance Sheet unclosed GL earnings", () => {
  it("adds actual open income less expense as one equity row", async () => {
    const db = fakeDb([
      journal("owner", "house", "2026-10-01", [debit("accounts_receivable", 20000), credit("rent_income", 20000)]),
      journal("owner", "house", "2026-10-02", [debit("maintenance", 5000), credit("operating_cash", 5000)]),
    ]);
    const report = await queryBalanceSheet(db, "owner", { to: "2026-10-05" });
    expect(report.rows.filter(row => row.account === "Unclosed earnings")).toEqual([
      { section: "Equity", account: "Unclosed earnings", amount: "$150.00" },
    ]);
    expect(report.meta).toMatchObject({ assets: "$150.00", liabilities: "$0.00", equity: "$150.00", balanced: true });
  });

  it("does not count already closed nominal balances a second time", async () => {
    const db = fakeDb([
      journal("owner", "house", "2026-10-01", [debit("accounts_receivable", 20000), credit("rent_income", 20000)]),
      journal("owner", "house", "2026-10-02", [debit("maintenance", 5000), credit("operating_cash", 5000)]),
      journal("owner", "house", "2026-10-03", [debit("rent_income", 20000), credit("retained_earnings", 20000)]),
      journal("owner", "house", "2026-10-03", [debit("retained_earnings", 5000), credit("maintenance", 5000)]),
    ]);
    const report = await queryBalanceSheet(db, "owner", { to: "2026-10-05" });
    expect(report.rows.some(row => row.account === "Unclosed earnings")).toBe(false);
    expect(report.meta).toMatchObject({ assets: "$150.00", equity: "$150.00", balanced: true });
  });

  it("shows a real loss and leaves a genuinely unbalanced journal visible", async () => {
    const loss = await queryBalanceSheet(fakeDb([
      journal("owner", "house", "2026-10-01", [debit("maintenance", 25000), credit("operating_cash", 25000)]),
    ]), "owner", { to: "2026-10-05" });
    expect(loss.rows.find(row => row.account === "Unclosed earnings")?.amount).toBe("-$250.00");
    expect(loss.meta).toMatchObject({ assets: "-$250.00", equity: "-$250.00", balanced: true });

    const imbalanced = await queryBalanceSheet(fakeDb([
      journal("owner", "house", "2026-10-01", [debit("accounts_receivable", 10000), credit("rent_income", 8000)]),
    ]), "owner", { to: "2026-10-05" });
    expect(imbalanced.meta).toMatchObject({ assets: "$100.00", equity: "$80.00", balanced: false });
  });

  it("uses the same owner, workspace-property, and as-of filters for earnings and assets", async () => {
    const db = fakeDb([
      journal("owner", "house-a", "2026-10-01", [debit("accounts_receivable", 10000), credit("rent_income", 10000)]),
      journal("owner", "house-b", "2026-10-01", [debit("accounts_receivable", 20000), credit("rent_income", 20000)]),
      journal("other", "house-a", "2026-10-01", [debit("accounts_receivable", 30000), credit("rent_income", 30000)]),
      journal("owner", "house-a", "2026-10-06", [debit("accounts_receivable", 40000), credit("rent_income", 40000)]),
    ]);
    const report = await queryBalanceSheet(db, "owner", {
      to: "2026-10-05", workspacePropertyIds: ["house-a"],
    });
    expect(report.meta).toMatchObject({ asOf: "2026-10-05", assets: "$100.00", equity: "$100.00", balanced: true });
    const excluded = await queryBalanceSheet(db, "owner", {
      to: "2026-10-05", workspacePropertyIds: ["house-a"], propertyId: "house-b",
    });
    expect(excluded.meta).toMatchObject({ assets: "$0.00", equity: "$0.00", balanced: true });
  });
});
