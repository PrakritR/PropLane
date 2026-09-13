import { describe, expect, it } from "vitest";
import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";

const applications: DemoApplicantRow[] = [
  {
    id: "app-1",
    bucket: "approved",
    email: "resident@example.com",
    propertyId: "mgr-4709a",
    assignedPropertyId: "mgr-4709a",
    property: "4709A 8th Ave NE",
    application: { propertyId: "mgr-4709a" },
  } as DemoApplicantRow,
];

function propertyWith(listing: Record<string, unknown>): Record<string, MockProperty | undefined> {
  return {
    "mgr-4709a": {
      id: "mgr-4709a",
      title: "4709A 8th Ave NE",
      buildingName: "4709A 8th Ave NE",
      address: "4709A 8th Ave NE, Seattle, WA",
      listingSubmission: {
        v: 1,
        buildingName: "4709A 8th Ave NE",
        address: "4709A 8th Ave NE, Seattle, WA",
        zip: "98115",
        houseRulesText: "",
        rooms: [],
        bathrooms: [],
        sharedSpaces: [],
        quickFacts: [],
        bundles: [],
        housePhotoDataUrls: [],
        ...listing,
      },
    } as unknown as MockProperty,
  };
}

describe("resolveResidentMoveInFromApplications house info", () => {
  it("resolves the structured sections a manager filled in", () => {
    let houseInfo = setHouseInfoValue(emptyHouseInfo(), "access", "doorCode", "001000");
    houseInfo = setHouseInfoValue(houseInfo, "wifi", "network", "4709A");
    houseInfo = setHouseInfoValue(houseInfo, "wifi", "password", "4709A4709A$$");

    const resolved = resolveResidentMoveInFromApplications(
      "resident@example.com",
      applications,
      propertyWith({ houseInfo }),
    );

    expect(resolved?.houseInfo.access.doorCode).toBe("001000");
    expect(resolved?.houseInfo.wifi.network).toBe("4709A");
  });

  it("stops pinning Wi-Fi to null — the regression that made the fields dead", () => {
    // These two were hard-coded to null in the resolver while the editor still
    // wrote them, so a manager could fill the Wi-Fi in and no resident ever saw
    // it. They now read through from the structured section.
    let houseInfo = setHouseInfoValue(emptyHouseInfo(), "wifi", "network", "4709A");
    houseInfo = setHouseInfoValue(houseInfo, "wifi", "password", "4709A4709A$$");

    const resolved = resolveResidentMoveInFromApplications(
      "resident@example.com",
      applications,
      propertyWith({ houseInfo }),
    );

    expect(resolved?.wifiNetworkName).toBe("4709A");
    expect(resolved?.wifiPassword).toBe("4709A4709A$$");
  });

  it("leaves a property nobody migrated exactly as it was", () => {
    const resolved = resolveResidentMoveInFromApplications(
      "resident@example.com",
      applications,
      propertyWith({ generalHouseInfo: "Front door code: 001000", houseRulesText: "Quiet hours 10pm–8am." }),
    );

    expect(resolved?.generalHouseInfo).toBe("Front door code: 001000");
    expect(resolved?.houseRulesText).toBe("Quiet hours 10pm–8am.");
    expect(resolved?.houseInfo.access.doorCode ?? "").toBe("");
    expect(resolved?.wifiNetworkName).toBeNull();
  });
});
