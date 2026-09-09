import { describe, expect, it } from "vitest";
import { buildMockPropertyFromDraft } from "@/lib/demo-property-pipeline";

describe("new manager listing map coordinates", () => {
  it("does not attach the retired Seattle placeholder to a new wizard listing", () => {
    const property = buildMockPropertyFromDraft(
      {
        buildingName: "QA address",
        address: "1 Market St",
        zip: "94105",
        neighborhood: "Financial District",
        unitLabel: "Room 2",
        beds: 1,
        baths: 1,
        monthlyRent: 1200,
        petFriendly: false,
      } as never,
      "mgr-qa-address",
    );

    expect(property.mapLat).toBeUndefined();
    expect(property.mapLng).toBeUndefined();
  });
});
