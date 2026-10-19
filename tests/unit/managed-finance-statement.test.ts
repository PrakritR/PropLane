import { describe, expect, it } from "vitest";
import { buildOwnerStatement, buildVendorStatement, statementReconciles, type StatementLine } from "@/lib/managed-finance/statement";

let n = 0;
const line = (kind: string, amount: number, postedAt: string, detail: Record<string, unknown> = {}): StatementLine => ({
  journalId: `j${++n}`, amountCents: amount, availableOn: null, postedAt, kind, detail, sourceType: null, sourceId: null,
});
const FROM = "2026-10-01T07:00:00.000Z";
const TO = "2026-11-01T07:00:00.000Z";

describe("owner statement", () => {
  const lines = [
    line("rent_capture", -90_000, "2026-09-05T10:00:00Z", { owner_cents: 90_000, fee_cents: 10_000 }), // before the period
    line("rent_capture", -90_001, "2026-10-02T10:00:00Z", { owner_cents: 90_001, fee_cents: 10_000 }),
    line("vendor_bill", 24_000, "2026-10-10T10:00:00Z", { title: "Leak repair", vendor_label: "Mike's Plumbing", job_href: "/portal/services/wo-1", property_id: "p1" }),
    line("refund", 22_501, "2026-10-12T10:00:00Z", { owner_cents: 22_501, fee_cents: 2_500 }),
    line("withdrawal_reserve", 50_000, "2026-10-20T10:00:00Z"),
    line("rent_capture", -45_000, "2026-11-02T10:00:00Z", { owner_cents: 45_000, fee_cents: 5_000 }), // after the period
  ];
  const s = buildOwnerStatement(lines, FROM, TO);
  it("shows rent gross, PropLane's cut and the owner's net, in the captain's terms", () => {
    expect(s.totals.rentGrossCents).toBe(100_001 - 25_001);
    expect(s.totals.feeCents).toBe(-10_000 + 2_500);
    expect(s.totals.vendorChargesCents).toBe(-24_000);
    expect(s.totals.netCents).toBe(90_001 - 24_000 - 22_501);
    expect(s.totals.withdrawalsCents).toBe(-50_000);
  });
  it("starts from the balance before the period and ends at the balance at its close", () => {
    expect(s.beginningCents).toBe(90_000);
    expect(s.endingCents).toBe(90_000 + 90_001 - 24_000 - 22_501 - 50_000);
    expect(statementReconciles(s)).toBe(true);
  });
  it("lists the vendor charge with its vendor, job link and house", () => {
    const row = s.rows.find((r) => r.kind === "vendor_charge")!;
    expect(row).toMatchObject({ label: "Leak repair · Mike's Plumbing", href: "/portal/services/wo-1", propertyId: "p1", amountCents: -24_000 });
  });
  it("a refund shows the fee coming back", () => {
    expect(s.rows.filter((r) => r.kind === "refund" || r.kind === "fee_returned").map((r) => r.amountCents)).toEqual([-25_001, 2_500]);
  });
  it("a dispute holds and a win releases; a failed withdrawal returns", () => {
    const ls = [
      line("rent_capture", -90_000, "2026-10-02T10:00:00Z", { owner_cents: 90_000, fee_cents: 10_000 }),
      line("dispute_opened", 90_000, "2026-10-03T10:00:00Z"),
      line("dispute_won", -90_000, "2026-10-09T10:00:00Z"),
      line("withdrawal_reserve", 10_000, "2026-10-10T10:00:00Z"),
      line("withdrawal_failed", -10_000, "2026-10-10T10:05:00Z"),
    ];
    const st = buildOwnerStatement(ls, FROM, TO);
    expect(st.endingCents).toBe(90_000);
    expect(statementReconciles(st)).toBe(true);
    expect(st.rows.map((r) => r.kind)).toEqual(["rent", "fee", "dispute_hold", "dispute_release", "withdrawal", "withdrawal_returned"]);
  });
  it("an empty month reconciles to the carried balance", () => {
    const st = buildOwnerStatement([line("rent_capture", -90_000, "2026-09-05T10:00:00Z", { owner_cents: 90_000, fee_cents: 10_000 })], FROM, TO);
    expect(st).toMatchObject({ beginningCents: 90_000, endingCents: 90_000, rows: [] });
    expect(statementReconciles(st)).toBe(true);
  });
});

describe("vendor statement", () => {
  it("shows bills owed and withdrawals, and reconciles", () => {
    const st = buildVendorStatement([
      line("vendor_bill", -24_000, "2026-10-10T10:00:00Z", { title: "Leak repair" }),
      line("vendor_bill", -10_000, "2026-10-11T10:00:00Z", { title: "Tour host fee" }),
      line("withdrawal_reserve", 34_000, "2026-10-14T10:00:00Z"),
    ], FROM, TO);
    expect(st.totals.vendorChargesCents).toBe(34_000);
    expect(st.totals.withdrawalsCents).toBe(-34_000);
    expect(st.endingCents).toBe(0);
    expect(statementReconciles(st)).toBe(true);
  });
});
