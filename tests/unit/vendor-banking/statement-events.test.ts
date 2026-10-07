import { describe, expect, it } from "vitest";
import {
  pacificMonthWindow,
  statementMonthKey,
  summarizeStatementMonths,
  vendorStatementEventType,
  VENDOR_STATEMENT_EVENT_LABELS,
  VENDOR_STATEMENT_EVENT_TYPES,
} from "@/lib/vendor-banking/statement-events";
import { makeFakeDb } from "./_fake-db";
import { buildVendorStatement, vendorStatementCsv } from "@/lib/vendor-banking/statement.server";

describe("vendorStatementEventType", () => {
  it.each([
    [{ kind: "charge", source: "invoice", description: "x" }, "charge"],
    [{ kind: "platform_fee", source: "invoice", description: "x" }, "fee"],
    [{ kind: "platform_fee", source: "withdrawal", description: "Instant payout fee" }, "instant_fee"],
    [{ kind: "hold", source: "invoice", description: "x" }, "hold"],
    [{ kind: "transfer", source: "invoice", description: "x" }, "transfer"],
    [{ kind: "withdrawal", source: "withdrawal", description: "Standard withdrawal" }, "withdrawal"],
    [{ kind: "refund", source: "refund", description: "x" }, "refund"],
    [{ kind: "refund", source: "hold_expiry", description: "Returned" }, "hold_expiry"],
    [{ kind: "adjustment", source: "hold_expiry", description: "fee reversed" }, "hold_expiry"],
    [{ kind: "dispute", source: "dispute", description: "Dispute lost — debited" }, "dispute"],
    [{ kind: "adjustment", source: "adjustment", description: "Dispute opened — frozen" }, "dispute"],
    [{ kind: "adjustment", source: "adjustment", description: "Goodwill" }, "adjustment"],
  ])("classifies %j as %s", (entry, type) => {
    expect(vendorStatementEventType(entry)).toBe(type);
  });

  it("every plan event type has a label", () => {
    for (const type of ["charge", "fee", "transfer", "withdrawal", "instant_fee", "refund", "dispute", "hold_expiry"]) {
      expect(VENDOR_STATEMENT_EVENT_TYPES).toContain(type);
    }
    for (const type of VENDOR_STATEMENT_EVENT_TYPES) expect(VENDOR_STATEMENT_EVENT_LABELS[type]).toBeTruthy();
  });
});

describe("summarizeStatementMonths", () => {
  it("chains opening and closing balances month to month, newest first", () => {
    const months = summarizeStatementMonths([
      { createdAt: "2026-10-03T19:00:00.000Z", amountCents: -5_000 },
      { createdAt: "2026-09-01T19:00:00.000Z", amountCents: 10_000 },
      { createdAt: "2026-09-02T19:00:00.000Z", amountCents: -300 },
      { createdAt: "2026-10-04T19:00:00.000Z", amountCents: 2_000 },
    ]);
    expect(months.map((m) => [m.month, m.openingCents, m.closingCents, m.lineCount])).toEqual([
      ["2026-10", 9_700, 6_700, 2],
      ["2026-09", 0, 9_700, 2],
    ]);
    expect(months[0]!.label).toBe("October 2026");
  });

  it("buckets on the PACIFIC month, so a line settled after 5pm PT on the last day stays in that month", () => {
    // 2026-10-01T00:00Z is Sep 30, 5pm PT — September, the month the vendor saw it in.
    expect(statementMonthKey("2026-10-01T00:00:00.000Z")).toBe("2026-09");
    expect(statementMonthKey("2026-10-01T07:00:00.000Z")).toBe("2026-10");
    const months = summarizeStatementMonths([
      { createdAt: "2026-10-01T00:00:00.000Z", amountCents: 10_000 },
      { createdAt: "2026-10-01T07:00:00.000Z", amountCents: 500 },
    ]);
    expect(months.map((m) => [m.month, m.lineCount])).toEqual([
      ["2026-10", 1],
      ["2026-09", 1],
    ]);
  });

  it("a Pacific month window covers the whole month and nothing of the next", () => {
    expect(pacificMonthWindow("2026-09")).toEqual({ start: "2026-09-01T07:00:00.000Z", end: "2026-10-01T07:00:00.000Z" });
    // December into January crosses the year AND standard time.
    expect(pacificMonthWindow("2026-12")).toEqual({ start: "2026-12-01T08:00:00.000Z", end: "2027-01-01T08:00:00.000Z" });
    expect(pacificMonthWindow("2026-13")).toBeNull();
  });

  it("a month with no lines has no statement", () => {
    expect(summarizeStatementMonths([])).toEqual([]);
  });
});

function row(overrides: Record<string, unknown>) {
  return {
    id: `e_${Math.random()}`,
    vendor_user_id: "vendor_1",
    manager_user_id: "manager_1",
    kind: "charge",
    amount_cents: 0,
    source: "invoice",
    source_id: "i1",
    description: "desc",
    stripe_object_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildVendorStatement — month view", () => {
  const db = makeFakeDb({
    vendor_banking_ledger_entries: [
      row({ kind: "charge", amount_cents: 10_000, created_at: "2026-08-30T00:00:00.000Z" }),
      row({ kind: "platform_fee", amount_cents: -300, created_at: "2026-08-30T00:00:01.000Z" }),
      row({ kind: "withdrawal", amount_cents: -5_000, source: "withdrawal", created_at: "2026-09-05T00:00:00.000Z" }),
      row({ kind: "platform_fee", amount_cents: -150, source: "withdrawal", description: "Instant payout fee", created_at: "2026-09-05T00:00:01.000Z" }),
    ],
  });

  it("opens with everything before the month and closes after the month's lines", async () => {
    const statement = await buildVendorStatement(db as never, "vendor_1", { month: "2026-09" });
    expect(statement.openingCents).toBe(9_700);
    expect(statement.closingCents).toBe(4_550);
    expect(statement.lines.map((l) => [l.eventType, l.runningBalanceCents])).toEqual([
      ["withdrawal", 4_700],
      ["instant_fee", 4_550],
    ]);
    expect(statement.months.map((m) => m.month)).toEqual(["2026-09", "2026-08"]);
  });

  it("a month with no activity still opens and closes at the carried balance", async () => {
    const statement = await buildVendorStatement(db as never, "vendor_1", { month: "2026-10" });
    expect(statement.lines).toEqual([]);
    expect([statement.openingCents, statement.closingCents]).toEqual([4_550, 4_550]);
  });

  it("a malformed month is treated as all time, never an injection", async () => {
    const statement = await buildVendorStatement(db as never, "vendor_1", { month: "2026-09'; drop" });
    expect(statement.lines).toHaveLength(4);
  });

  it("pages past the provider row cap — a long-lived vendor's closing balance is the real one", async () => {
    const rows = Array.from({ length: 2_350 }, (_, i) =>
      row({
        id: `e_${String(i).padStart(5, "0")}`,
        kind: "charge",
        amount_cents: 100,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString(),
      }),
    );
    const paged = makeFakeDb({ vendor_banking_ledger_entries: rows });
    const statement = await buildVendorStatement(paged as never, "vendor_1");
    expect(statement.lines).toHaveLength(2_350);
    expect(statement.closingCents).toBe(235_000);
  });

  it("the CSV names each line by its event type and defuses formulas", () => {
    const csv = vendorStatementCsv({
      lines: [
        { id: "1", vendorUserId: "v", managerUserId: null, kind: "withdrawal", amountCents: -5_000, source: "withdrawal", sourceId: null, description: "=HYPERLINK(\"x\")", stripeObjectId: null, createdAt: "2026-09-05T00:00:00.000Z", runningBalanceCents: 100, eventType: "withdrawal" },
        { id: "2", vendorUserId: "v", managerUserId: null, kind: "platform_fee", amountCents: -150, source: "withdrawal", sourceId: null, description: "Instant payout fee", stripeObjectId: null, createdAt: "2026-09-05T00:00:01.000Z", runningBalanceCents: 50, eventType: "instant_fee" },
      ],
    });
    const rows = csv.split("\n");
    expect(rows[1]).toContain('"Withdrawal"');
    expect(rows[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(rows[2]).toContain('"Instant payout fee"');
  });
});
