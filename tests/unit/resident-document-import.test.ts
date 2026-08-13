import { describe, expect, it } from "vitest";
import { matchPropertyFromCatalog, matchRoomInProperty, propertyCatalogFromSubmission } from "@/lib/resident-document-import/property-catalog";
import { matchResidentFromApplications } from "@/lib/resident-document-import/match-resident";
import { firstEmail, labeledValue } from "@/lib/resident-document-import/text-extract";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const baseSub = {
  buildingName: "Oak House",
  streetAddress: "123 Main St",
  city: "Seattle",
  state: "WA",
  zipCode: "98101",
  rooms: [{ id: "room-a", name: "Room A", monthlyRent: 1200 }],
} as ManagerListingSubmissionV1;

describe("resident-document-import text extract", () => {
  it("finds a labeled tenant email", () => {
    const text = "Tenant email: jane@example.com\nOther line";
    expect(firstEmail(text)).toBe("jane@example.com");
    expect(labeledValue(text, ["tenant email"])).toBe("jane@example.com");
  });
});

describe("resident-document-import property match", () => {
  it("matches property by id and room label", () => {
    const catalog = [propertyCatalogFromSubmission("prop-1", baseSub)];
    const hit = matchPropertyFromCatalog(catalog, {
      propertyId: "prop-1",
      addressText: "123 Main St Seattle",
    });
    expect(hit?.propertyId).toBe("prop-1");
    const room = matchRoomInProperty(hit!, "Room A");
    expect(room?.roomId).toBe("room-a");
  });
});

describe("resident-document-import resident match", () => {
  it("matches an existing resident by email", () => {
    const match = matchResidentFromApplications(
      [{ id: "PROPLANE-ABC", name: "Jane", email: "jane@example.com", bucket: "approved", property: "Oak" }],
      { email: "jane@example.com" },
      "mgr-1",
    );
    expect(match.kind).toBe("existing");
    if (match.kind === "existing") expect(match.applicationId).toBe("PROPLANE-ABC");
  });
});
