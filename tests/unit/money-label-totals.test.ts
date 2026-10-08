import { describe, expect, it } from "vitest";
import { formatCentsAsUsd, sumMoneyLabelsCents, sumMoneyRowsCents } from "@/lib/money-label-totals";

describe("money label totals (the stat strip above the money lists)", () => {
  it("sums the labels a row shows, in whole cents, so a card never drifts from its rows", () => {
    expect(sumMoneyLabelsCents(["$1,150.00", "$1,100.00", "$0.10", "$0.20"])).toBe(225030);
    expect(formatCentsAsUsd(sumMoneyLabelsCents(["$525.00"]))).toBe("$525.00");
  });
  it("treats a row with no figure as nothing, never as NaN", () => {
    expect(sumMoneyLabelsCents(["—", "", null, undefined, "$20.00"])).toBe(2000);
    expect(formatCentsAsUsd(0)).toBe("$0.00");
  });
});

describe("money totals read the row's own figure first", () => {
  it("sums `cents` when the row carries one, so the label is never re-parsed", () => {
    expect(sumMoneyRowsCents([{ cents: 115000, label: "$1,150.00" }, { cents: 2500, label: "$25.00" }])).toBe(117500);
    // A free-text cost ("approx 1.5k") is what the label falls back to; it is not a figure.
    expect(sumMoneyRowsCents([{ cents: 150000, label: "approx 1.5k" }])).toBe(150000);
  });
  it("ignores free text when there is no figure, rather than inventing a small one", () => {
    expect(sumMoneyRowsCents([{ label: "approx 1.5k" }, { label: "ask vendor" }, { label: "TBD" }])).toBe(0);
    expect(sumMoneyRowsCents([{ cents: null, label: "$40.00" }])).toBe(4000);
  });
  it("subtracts a credit instead of adding it", () => {
    expect(sumMoneyLabelsCents(["$100.00", "-$25.00"])).toBe(7500);
    expect(sumMoneyLabelsCents(["$100.00", "($25.00)"])).toBe(7500);
    expect(sumMoneyRowsCents([{ cents: -2500 }])).toBe(-2500);
  });
});
