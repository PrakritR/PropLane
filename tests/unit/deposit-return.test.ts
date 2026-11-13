import { expect, it } from "vitest";
import { depositRemainingCents } from "@/lib/deposit-return";

it("does not report a negative remaining deposit", () => {
  expect(depositRemainingCents({ paidCents: 75_000, alreadyReturnedCents: 0 })).toBe(75_000);
  expect(depositRemainingCents({ paidCents: 75_000, alreadyReturnedCents: 25_000 })).toBe(50_000);
  expect(depositRemainingCents({ paidCents: 50_000, alreadyReturnedCents: 60_000 })).toBe(0);
});
