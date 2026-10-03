import { describe, expect, it } from "vitest";
import { UNCOUNTER_SIGN_REFUND_AFTER_DAYS } from "@/lib/lease-uncountersigned-refund.server";

describe("lease uncountersigned refund policy", () => {
  it("uses a 45-day manager countersign window", () => {
    expect(UNCOUNTER_SIGN_REFUND_AFTER_DAYS).toBe(45);
  });
});
