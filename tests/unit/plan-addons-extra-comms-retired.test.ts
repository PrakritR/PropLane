/**
 * Monthly communication-credit add-on is retired — credit is bought under
 * Extra usage (Embedded Checkout), not as a recurring plan add-on.
 */
import { describe, expect, it } from "vitest";
import { PLAN_ADDON_STOREFRONT_IDS, planAddon } from "@/lib/plan-addons";
import { setManagerPlanAddonQuantities } from "@/lib/plan-addons.server";

describe("extra_comms_credit is retired from monthly sale", () => {
  it("is not on the Billing storefront", () => {
    expect(PLAN_ADDON_STOREFRONT_IDS).not.toContain("extra_comms_credit");
  });

  it("is capped at zero so it cannot be increased via catalogue max", () => {
    expect(planAddon("extra_comms_credit").maxQuantity.pro).toBe(0);
    expect(planAddon("extra_comms_credit").maxQuantity.business).toBe(0);
  });

  it("cannot be bought or changed — refused before Stripe", async () => {
    const result = await setManagerPlanAddonQuantities({
      managerUserId: "mgr-1",
      changes: [{ addonId: "extra_comms_credit", quantity: 1 }],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Communication credits are not sold as monthly add-ons. Use Extra usage instead.",
    });
  });
});
