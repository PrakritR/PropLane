import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatChargeMoneyLabel, humanizeChargeDate } from "@/lib/charge-due-label";
import {
  chargeDueLabel,
  householdChargeDueDate,
  residentChargeAmountLabel,
  residentChargeBucket,
} from "@/lib/household-charges";
import type { HouseholdCharge } from "@/lib/household-charges";
import { recordSections } from "@/lib/portals/record-sections";

function makeCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "chg-1",
    kind: "move_in_fee",
    status: "pending",
    amountLabel: "$1800.00",
    balanceLabel: "$1800.00",
    dueDateLabel: "2026-10-07",
    residentEmail: "r@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    propertyLabel: "Alder House",
    managerUserId: "mgr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    title: "Move-in fee",
    ...overrides,
  } as HouseholdCharge;
}

describe("A1 · Pay only while a charge is owed", () => {
  const payIds = (ctx: Parameters<typeof recordSections>[2]) =>
    recordSections("resident", "payment", ctx).headerActions.map((a) => a.id);

  it("keeps Pay on the record header by default and while owed", () => {
    expect(payIds({ basePath: "/resident", bucket: "overdue" })).toContain("pay");
    expect(payIds({ basePath: "/resident", bucket: "overdue", paymentOwed: true })).toContain("pay");
  });

  it("drops Pay from the record header once the charge is settled", () => {
    expect(payIds({ basePath: "/resident", bucket: "paid", paymentOwed: false })).not.toContain("pay");
  });

  it("never touches another kind's header", () => {
    const manager = recordSections("manager", "payment", { paymentOwed: false }).headerActions.map((a) => a.id);
    expect(manager).toEqual(recordSections("manager", "payment", {}).headerActions.map((a) => a.id));
  });

  it("gates the row menu's Pay on a selected charge that is still owed", () => {
    const src = readFileSync("src/components/portal/resident-payments-panel.tsx", "utf8");
    expect(src).toContain("selectionHasOwedCharge");
    expect(src).toContain("unpaidPayableCharges.some((c) => selectedIds.has(c.id))");
    expect(src).toContain("paymentOwed: chargePayable");
  });

  it("buckets a charge by what the tabs show", () => {
    expect(residentChargeBucket(makeCharge({ status: "paid" }))).toBe("paid");
    expect(residentChargeBucket(makeCharge({ status: "processing", dueDateLabel: "Jan 1, 2020" }))).toBe("pending");
    expect(residentChargeBucket(makeCharge({ dueDateLabel: "Jan 1, 2020" }), new Date("2026-06-01"))).toBe("overdue");
    expect(residentChargeBucket(makeCharge({ dueDateLabel: "Dec 1, 2026" }), new Date("2026-06-01"))).toBe("pending");
  });
});

describe("A2 · ISO dates read as the product's date", () => {
  it("formats an ISO date without shifting it by timezone", () => {
    expect(humanizeChargeDate("2026-10-07")).toBe("Oct 7, 2026");
    expect(humanizeChargeDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(humanizeChargeDate("2026-12-31T00:00:00.000Z")).toBe("Dec 31, 2026");
  });
  it("keeps a By / Before prefix and leaves phrases and display dates alone", () => {
    expect(humanizeChargeDate("By 2026-10-07")).toBe("By Oct 7, 2026");
    expect(humanizeChargeDate("before 2026-10-07")).toBe("Before Oct 7, 2026");
    expect(humanizeChargeDate("Before move-in")).toBe("Before move-in");
    expect(humanizeChargeDate("Oct 7, 2026")).toBe("Oct 7, 2026");
    expect(humanizeChargeDate("2026-13-45")).toBe("2026-13-45");
  });
  it("chargeDueLabel never returns ISO", () => {
    expect(chargeDueLabel(makeCharge({ dueDateLabel: "2026-10-07" }))).toBe("Oct 7, 2026");
  });
  it("an ISO due date is the same calendar day for sorting and overdue checks", () => {
    const due = householdChargeDueDate(makeCharge({ dueDateLabel: "2026-10-07" }))!;
    expect([due.getFullYear(), due.getMonth(), due.getDate()]).toEqual([2026, 9, 7]);
  });
});

describe("A3 · amounts carry thousands separators", () => {
  it("formats a plain amount label", () => {
    expect(formatChargeMoneyLabel("$1800.00")).toBe("$1,800.00");
    expect(formatChargeMoneyLabel("1800")).toBe("$1,800.00");
    expect(formatChargeMoneyLabel("$1,800.00")).toBe("$1,800.00");
    expect(formatChargeMoneyLabel("$130.65")).toBe("$130.65");
    expect(formatChargeMoneyLabel("-$25.5")).toBe("-$25.50");
  });
  it("leaves a label that is not an amount unchanged", () => {
    expect(formatChargeMoneyLabel("Varies")).toBe("Varies");
    expect(formatChargeMoneyLabel("")).toBe("");
  });
  it("residentChargeAmountLabel formats unpaid and paid fallbacks", () => {
    expect(residentChargeAmountLabel(makeCharge())).toBe("$1,800.00");
    expect(residentChargeAmountLabel(makeCharge({ status: "paid", balanceLabel: "$0.00" }))).toBe("$1,800.00");
    expect(residentChargeAmountLabel(makeCharge({ status: "paid", paidAmountCents: 180000 }))).toBe("$1,800.00");
  });
});

describe("A4 · ?pay= survives the bare /payments redirect", () => {
  it("carries the pay param and opens the charge record from the panel", () => {
    const render = readFileSync("src/lib/render-portal-section.tsx", "utf8");
    expect(render).toContain("searchSuffix(undefined, { pay: payParam })");
    const panel = readFileSync("src/components/portal/resident-payments-panel.tsx", "utf8");
    expect(panel).toContain("residentChargeDetailHref(basePath, residentChargeBucket(target), target.id)");
  });
});
