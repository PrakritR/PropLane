import { describe, expect, it } from "vitest";
import {
  dedupeAddressSegments,
  propertyRowAddress,
  propertyRowAddressLine,
  propertyRowLocality,
  propertyRowMeta,
  propertyRowRentLabel,
  propertyRowSummary,
  propertyRowThumbnail,
  propertyRowTitle,
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
    expect(propertyRowSummary(shared)).toBe("From $1,000/mo · 2 rooms · 1 ba · Green Lake");
    const whole = { ...shared, submission: sub({ listingPlaceCategoryId: "entire_home", rooms: [room("A", 2400)] }) };
    expect(propertyRowSummary(whole)).toBe("$2,400/mo · 1 ba · Green Lake");
  });

  it("shows the first real photo and nothing when there is none", () => {
    expect(propertyRowThumbnail({ submission: sub({ rooms: [room("A", 1, ["data:image/png;base64,x"])] }) })).toBe(
      "data:image/png;base64,x",
    );
    expect(propertyRowThumbnail({ submission: sub({ housePhotoDataUrls: ["  "], rooms: [room("A", 1)] }) })).toBeNull();
    expect(propertyRowThumbnail({ submission: undefined })).toBeNull();
  });
});

describe("property row title and address lines (PLAN-0914-1345)", () => {
  it("uses the street as the title when the name is blank or a bare number", () => {
    const base = { address: "41932 Paseo Padre Pkwy, 41932 Paseo Padre Pkwy, 94539", zip: "94539" };
    expect(propertyRowTitle({ ...base, buildingName: "2" })).toBe("41932 Paseo Padre Pkwy");
    expect(propertyRowTitle({ ...base, buildingName: "" })).toBe("41932 Paseo Padre Pkwy");
    expect(propertyRowTitle({ ...base, buildingName: "  #12 " })).toBe("41932 Paseo Padre Pkwy");
    expect(propertyRowTitle({ ...base, buildingName: "Jain Home" })).toBe("Jain Home");
    expect(propertyRowTitle({ buildingName: "", address: "" })).toBe("Untitled property");
  });

  it("collapses a street the geocoder handed over twice", () => {
    expect(dedupeAddressSegments("41932 Paseo Padre Pkwy, 41932 Paseo Padre Pkwy, 94539")).toBe(
      "41932 Paseo Padre Pkwy, 94539",
    );
    expect(dedupeAddressSegments("142 Ash St, Seattle, WA")).toBe("142 Ash St, Seattle, WA");
    expect(propertyRowAddress({ address: "41932 Paseo Padre Pkwy, 41932 Paseo Padre Pkwy", zip: "94539" })).toBe(
      "41932 Paseo Padre Pkwy, 94539",
    );
  });

  it("puts city, state and ZIP on the second line — once — and the street only when the title is a name", () => {
    const draft = {
      buildingName: "2",
      address: "41932 Paseo Padre Pkwy, 41932 Paseo Padre Pkwy",
      zip: "94539",
      neighborhood: "",
      submission: sub({ address: "41932 Paseo Padre Pkwy", city: "Fremont", state: "CA", zip: "94539" }),
    };
    expect(propertyRowAddressLine(draft)).toBe("Fremont, CA 94539");

    const named = {
      buildingName: "Jain Home",
      address: "4709A 8th Ave NE, Seattle, WA 98105",
      zip: "98105",
      neighborhood: "University District",
      submission: sub({ address: "4709A 8th Ave NE, Seattle, WA 98105", city: "Seattle", state: "WA", zip: "98105" }),
    };
    expect(propertyRowAddressLine(named)).toBe("4709A 8th Ave NE · Seattle, WA 98105 · University District");
    expect(propertyRowLocality(named)).toBe("Seattle, WA 98105");
  });

  it("falls back to the address tail when the submission carries no city", () => {
    expect(
      propertyRowLocality({ address: "142 Ash St, Seattle, WA 98166", zip: "98166", submission: undefined }),
    ).toBe("Seattle, WA 98166");
    expect(propertyRowLocality({ address: "142 Ash St", zip: "98166", submission: undefined })).toBe("98166");
  });

  it("reads bath, room and resident counts for the glyph line; omits beds; entire homes carry no room count", () => {
    expect(propertyRowMeta({ beds: 2, baths: 1, submission: sub({ rooms: [room("A", 900), room("B", 900)] }) })).toEqual({
      baths: 1,
      rooms: 2,
      residents: null,
    });
    expect(
      propertyRowMeta({ beds: 3, baths: 2, submission: sub({ listingPlaceCategoryId: "entire_home", rooms: [room("A", 2400)] }) }),
    ).toEqual({ baths: 2, rooms: null, residents: null });
  });

  it("shows Σ residents when any room holds 2+", () => {
    const shared = { ...room("A", 900), occupancyCapacity: 2 };
    const solo = { ...room("B", 900), occupancyCapacity: 1 };
    expect(propertyRowMeta({ beds: 2, baths: 1, submission: sub({ rooms: [shared, solo] }) })).toEqual({
      baths: 1,
      rooms: 2,
      residents: 3,
    });
  });

  it("shows the Basics bathroom count when saved baths is still the default 1", () => {
    expect(
      propertyRowMeta({
        beds: 9,
        baths: 1,
        submission: sub({ listingTotalBathroomsId: "3", rooms: Array.from({ length: 9 }, (_, i) => room(`R${i + 1}`, 900)) }),
      }),
    ).toEqual({ baths: 3, rooms: 9, residents: null });
    expect(
      propertyRowMeta({
        beds: 2,
        baths: 1,
        submission: sub({ listingTotalBathroomsId: "1.5", rooms: [room("A", 900), room("B", 900)] }),
      }),
    ).toEqual({ baths: 1.5, rooms: 2, residents: null });
  });
});
