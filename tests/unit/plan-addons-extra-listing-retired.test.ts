/**
 * `extra_listing` retirement (PLAN-DOOR step 2): per-door billing prices extra
 * doors directly, so a per-listing add-on would double-price the same axis.
 * It is removed from the sellable catalogue and from `PlanAddonId`, so it can
 * no longer be bought or have its quantity changed through the product — see
 * `src/lib/plan-addons.ts`'s file comment for what that leaves behind for an
 * account that already holds one (the row and any Stripe item are untouched;
 * `workspace-plan-addons.test.ts` covers that an existing row is read safely,
 * without crashing or inflating a limit).
 */
import { describe, expect, it } from "vitest";
import { PLAN_ADDONS, PLAN_ADDON_IDS, isPlanAddonId } from "@/lib/plan-addons";
import { setManagerPlanAddonQuantities } from "@/lib/plan-addons.server";

describe("extra_listing is retired from sale", () => {
  it("is not in the purchasable catalogue", () => {
    expect(PLAN_ADDONS.some((addon) => addon.id === "extra_listing")).toBe(false);
    expect(PLAN_ADDON_IDS).not.toContain("extra_listing");
  });

  it("is not a recognized add-on id", () => {
    expect(isPlanAddonId("extra_listing")).toBe(false);
  });

  it("cannot be bought or changed — refused before any plan or Stripe read", async () => {
    const result = await setManagerPlanAddonQuantities({
      managerUserId: "mgr-1",
      changes: [{ addonId: "extra_listing" as never, quantity: 1 }],
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Unknown add-on." });
  });
});
