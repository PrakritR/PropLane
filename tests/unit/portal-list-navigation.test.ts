import { describe, expect, it } from "vitest";
import { buildPortalListNavigation } from "@/lib/portal-list-navigation";

describe("buildPortalListNavigation", () => {
  it("returns position and neighbor hrefs for the current index", () => {
    const items = ["a", "b", "c"];
    const nav = buildPortalListNavigation(items, 1, (item) => `/items/${item}`);
    expect(nav).toEqual({
      positionLabel: "2 of 3",
      prevHref: "/items/a",
      nextHref: "/items/c",
    });
  });

  it("omits prev on the first item and next on the last", () => {
    const items = ["only"];
    expect(buildPortalListNavigation(items, 0, (item) => item)).toBeUndefined();

    const many = ["a", "b"];
    const first = buildPortalListNavigation(many, 0, (item) => item);
    expect(first?.prevHref).toBeUndefined();
    expect(first?.nextHref).toBe("b");

    const last = buildPortalListNavigation(many, 1, (item) => item);
    expect(last?.prevHref).toBe("a");
    expect(last?.nextHref).toBeUndefined();
  });
});
