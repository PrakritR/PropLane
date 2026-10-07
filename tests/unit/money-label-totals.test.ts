import { describe, expect, it } from "vitest";
import { formatCentsAsUsd, sumMoneyLabelsCents } from "@/lib/money-label-totals";

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
