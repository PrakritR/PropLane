// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readExtraListingsForUser, seedDemoManagerProperties } from "@/lib/demo-property-pipeline";
import type { MockProperty } from "@/data/types";

/**
 * A browser-store listing row without an id used to reach every property
 * picker and crash it on `.trim()`. The reader drops that row and fills the
 * text fields the pickers trim, so no consumer has to guard for it.
 */
const USER = "manager-store-test";
const good: MockProperty = {
  id: "house-1", title: "Cedar Lane Duplex", tagline: "", address: "1 Cedar Ln", zip: "98101", neighborhood: "",
  beds: 2, baths: 1, rentLabel: "$2,000", available: "Now", petFriendly: false, buildingId: "b1", buildingName: "Cedar Lane Duplex", unitLabel: "A",
};

describe("cached extra listings are sanitized at the reader", () => {
  beforeEach(() => window.localStorage.clear());

  it("drops a row with no id and keeps the rest", () => {
    const bad = { ...good, id: undefined } as unknown as MockProperty;
    seedDemoManagerProperties(USER, [bad, good]);
    expect(readExtraListingsForUser(USER).map((p) => p.id)).toEqual(["house-1"]);
  });

  it("fills a missing text field so pickers can trim it", () => {
    const partial = { ...good, id: "house-2", buildingName: undefined, title: undefined } as unknown as MockProperty;
    seedDemoManagerProperties(USER, [partial]);
    const [row] = readExtraListingsForUser(USER);
    expect(row?.buildingName).toBe("");
    expect(row?.title).toBe("");
  });
});
