import { describe, expect, it } from "vitest";
import { formatChargeDueLabel, looksLikeDueDate } from "@/lib/charge-due-label";

describe("charge due label", () => {
  it("renders a By window as 'Due by <date>'", () => {
    expect(formatChargeDueLabel("By Oct 12, 2026")).toBe("Due by Oct 12, 2026");
    expect(looksLikeDueDate("By Oct 12, 2026")).toBe(true);
  });
  it("renders a bare date as 'Due <date>'", () => {
    expect(formatChargeDueLabel("Nov 1, 2026")).toBe("Due Nov 1, 2026");
  });
  it("leaves phrases alone", () => {
    expect(formatChargeDueLabel("Before move-in")).toBe("Before move-in");
    expect(looksLikeDueDate("Card declined. Pay again")).toBe(false);
  });
});
