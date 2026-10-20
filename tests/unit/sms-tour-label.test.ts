import { describe, expect, it } from "vitest";
import { smsTourLabel } from "@/lib/tools/domains/tours";

describe("smsTourLabel", () => {
  it("drops the date key and the middle dot a prospect should never read", () => {
    expect(smsTourLabel("Oct 22, 9:00 AM - 9:30 AM · 2026-10-22 Pacific")).toBe("Oct 22, 9:00 AM - 9:30 AM");
  });

  it("leaves a label with no suffix alone and turns a stray middle dot into a hyphen", () => {
    expect(smsTourLabel("Thu, Oct 22 9:00 AM")).toBe("Thu, Oct 22 9:00 AM");
    expect(smsTourLabel("Oct 22 · 9 AM")).toBe("Oct 22 - 9 AM");
  });
});
