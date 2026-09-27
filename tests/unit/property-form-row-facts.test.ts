import { describe, expect, it } from "vitest";
import { formatFeeCentsForFact } from "@/lib/property-form-row-facts";

/**
 * Display-only formatting for the Application/Lease row facts (P001, P004,
 * P007, P009). The real fee VALUE always comes from
 * `manager-application-settings.ts` / `leasing-pipeline-preferences.ts`
 * (already covered by their own suites) — this only covers turning cents
 * into the row's fee text.
 */
describe("formatFeeCentsForFact", () => {
  it("formats a whole-dollar fee with no decimals", () => {
    expect(formatFeeCentsForFact(5000)).toBe("$50");
    expect(formatFeeCentsForFact(10000)).toBe("$100");
  });

  it("formats a fee with cents", () => {
    expect(formatFeeCentsForFact(4999)).toBe("$49.99");
    expect(formatFeeCentsForFact(150)).toBe("$1.50");
  });

  it("formats zero as a whole-dollar amount", () => {
    expect(formatFeeCentsForFact(0)).toBe("$0");
  });
});
