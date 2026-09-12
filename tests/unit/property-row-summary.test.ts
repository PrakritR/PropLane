import { describe, expect, it } from "vitest";
import {
  propertyRowAddress,
  propertyRowRentLabel,
  propertyRowSummary,
  propertyRowThumbnail,
} from "@/lib/property-row-summary";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

function sub(overrides: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 {
  return { ...createDefaultListingSubmission(), ...overrides } as ManagerListingSubmissionV1;
}

const room = (name: string, monthlyRent: number, photos: string[] = []) => ({
  ...createDefaultListingSubmission().rooms[0]!,
  id: name.toLowerCase(),
  name,
  monthlyRent,
  photoDataUrls: photos,
});

describe("property row summary", () => {
  it("never repeats the ZIP the address already ends with", () => {
    expect(propertyRowAddress({ address: "142 Ash St, Seattle, WA 98166", zip: "98166" })).toBe(
      "142 Ash St, Seattle, WA 98166",
    );
    expect(propertyRowAddress({ address: "142 Ash St, Seattle, WA", zip: "98166" })).toBe(
      "142 Ash St, Seattle, WA, 98166",
    );
    expect(propertyRowAddress({ address: "142 Ash St", zip: "" })).toBe("142 Ash St");
  });

  it("quotes a from-price in whole dollars off the rooms, not the cents label", () => {
    const row = {
      monthlyRent: 1160,
      rentRangeLabel: "$1160.00–1210.00/mo",
      submission: sub({ rooms: [room("A", 1160), room("B", 1210)] }),
    };
    expect(propertyRowRentLabel(row)).toBe("From $1,160/mo");
  });

  it("drops 'From' when every room charges the same", () => {
    const row = { monthlyRent: 1200, submission: sub({ rooms: [room("A", 1200), room("B", 1200)] }) };
    expect(propertyRowRentLabel(row)).toBe("$1,200/mo");
  });

  it("falls back to the stored label, cents stripped, for a row without a submission", () => {
    expect(propertyRowRentLabel({ monthlyRent: 0, rentRangeLabel: "$1160.00–1210.00/mo" })).toBe("From $1,160/mo");
    expect(propertyRowRentLabel({ monthlyRent: 950 })).toBe("$950/mo");
    expect(propertyRowRentLabel({ monthlyRent: 0 })).toBe("Rent not set");
  });

  it("says how many rooms a by-the-room listing has, and not for a whole place", () => {
    const shared = {
      monthlyRent: 1000,
      beds: 2,
      baths: 1,
      neighborhood: "Green Lake",
      submission: sub({ listingPlaceCategoryId: "shared_home", rooms: [room("A", 1000), room("B", 1100)] }),
    };
    expect(propertyRowSummary(shared)).toBe("From $1,000/mo · 2 rooms · 2 bd / 1 ba · Green Lake");
    const whole = { ...shared, submission: sub({ listingPlaceCategoryId: "entire_home", rooms: [room("A", 2400)] }) };
    expect(propertyRowSummary(whole)).toBe("$2,400/mo · 2 bd / 1 ba · Green Lake");
  });

  it("shows the first real photo and nothing when there is none", () => {
    expect(propertyRowThumbnail({ submission: sub({ rooms: [room("A", 1, ["data:image/png;base64,x"])] }) })).toBe(
      "data:image/png;base64,x",
    );
    expect(propertyRowThumbnail({ submission: sub({ housePhotoDataUrls: ["  "], rooms: [room("A", 1)] }) })).toBeNull();
    expect(propertyRowThumbnail({ submission: undefined })).toBeNull();
  });
});
