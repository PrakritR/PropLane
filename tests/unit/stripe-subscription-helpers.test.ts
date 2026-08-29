import { describe, expect, it, vi } from "vitest";
import {
  isStripeSubscriptionStatusBillable,
  stripeSubscriptionIsBillable,
} from "@/lib/stripe-subscription-helpers";

describe("stripeSubscriptionIsBillable", () => {
  it("treats canceled and incomplete_expired as not billable", () => {
    expect(isStripeSubscriptionStatusBillable("active")).toBe(true);
    expect(isStripeSubscriptionStatusBillable("trialing")).toBe(true);
    expect(isStripeSubscriptionStatusBillable("canceled")).toBe(false);
    expect(isStripeSubscriptionStatusBillable("incomplete_expired")).toBe(false);
  });

  it("returns false for empty subscription ids", async () => {
    await expect(stripeSubscriptionIsBillable(null)).resolves.toBe(false);
    await expect(stripeSubscriptionIsBillable("")).resolves.toBe(false);
  });

  it("returns false when Stripe reports resource_missing", async () => {
    const retrieve = vi.fn(async () => {
      throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
    });
    await expect(stripeSubscriptionIsBillable("sub_missing", retrieve)).resolves.toBe(false);
  });

  it("returns true for an active subscription", async () => {
    const retrieve = vi.fn(async () => ({ status: "active" }));
    await expect(stripeSubscriptionIsBillable("sub_active", retrieve)).resolves.toBe(true);
  });
});
