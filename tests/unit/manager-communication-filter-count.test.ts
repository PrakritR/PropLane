import { describe, expect, it } from "vitest";
import { communicationFilterTouches } from "@/components/portal/manager-communication";

describe("manager Communication active filter count", () => {
  it("counts selected contacts alongside property, role, and sort filters", () => {
    expect(
      communicationFilterTouches(
        { propertyIds: [], roles: [], contactIds: ["resident-1"] },
        "recent",
      ),
    ).toBe(1);
  });
});
