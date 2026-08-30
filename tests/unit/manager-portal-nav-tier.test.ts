import { describe, expect, it } from "vitest";
import { pickManagerPortalNavSubscriptionTier } from "@/lib/manager-access";

describe("pickManagerPortalNavSubscriptionTier", () => {
  it("keeps the manager's own tier when they own properties", () => {
    expect(pickManagerPortalNavSubscriptionTier("free", true, ["paid"])).toBe("free");
    expect(pickManagerPortalNavSubscriptionTier("paid", true, ["free"])).toBe("paid");
  });

  it("inherits the best linked-owner tier for a pure co-manager", () => {
    expect(pickManagerPortalNavSubscriptionTier("free", false, ["paid", "free"])).toBe("paid");
    expect(pickManagerPortalNavSubscriptionTier("free", false, [null, "free"])).toBe(null);
    expect(pickManagerPortalNavSubscriptionTier("free", false, [])).toBe("free");
  });
});
