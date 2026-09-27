import { describe, expect, it } from "vitest";
import { buildZillowRentalFeedXml } from "@/lib/listing-syndication/zillow-feed";
import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** A publicListingProjection-shaped listing — only allowlisted fields set. */
function projectedListing(overrides: Partial<MockProperty> = {}): MockProperty {
  const sub = {
    v: 1,
    buildingName: "Ballard House",
    address: "123 Main St",
    zip: "98107",
    city: "",
    state: "",
    neighborhood: "Ballard",
    homeStructureNote: "",
    listingPlaceCategoryId: "entire_home",
    listingBedroomSlots: 3,
    houseOverview: "A lovely home near the water",
    housePhotoDataUrls: ["https://cdn.proplane.test/photo1.jpg"],
    entireHomeMonthlyRent: 2200,
    houseSizeSqft: 1200,
    rooms: [],
    bathrooms: [],
    sharedSpaces: [],
    bundles: [],
    quickFacts: [],
    houseRulesText: "",
    amenitiesText: "",
    leaseTermsBody: "",
    applicationFee: "45",
    securityDeposit: "500",
    moveInFee: "0",
    paymentAtSigningIncludes: [],
    houseCostsDetail: "",
    parkingMonthly: "0",
    hoaMonthly: "0",
    otherMonthlyFees: "0",
  } as unknown as ManagerListingSubmissionV1;

  return {
    id: "prop-1",
    title: "Ballard House",
    tagline: "",
    address: "123 Main St",
    zip: "98107",
    neighborhood: "Ballard",
    beds: 3,
    baths: 2,
    rentLabel: "$2,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Ballard House",
    unitLabel: "",
    mapLat: 47.668,
    mapLng: -122.383,
    managerUserId: "mgr-1",
    contactWorkEmail: "leasing@proplane.test",
    contactSmsPhone: "+12065551234",
    managerContactEmail: "personal@example.com",
    publicProjection: true,
    listingSubmission: sub,
    ...overrides,
  } as unknown as MockProperty;
}

/** Every distinct XML element name, from opening/self-closing/closing tags alike. */
function elementNames(xml: string): string[] {
  const names = new Set<string>();
  for (const match of xml.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)) names.add(match[1]!);
  return [...names].sort();
}

describe("buildZillowRentalFeedXml", () => {
  it("renders exactly the documented element set — a new field must update this list deliberately", () => {
    const { xml, includedIds, excluded } = buildZillowRentalFeedXml([projectedListing()], "https://prop-lane.space");
    expect(excluded).toEqual([]);
    expect(includedIds).toEqual(["prop-1"]);
    expect(elementNames(xml)).toEqual(
      [
        "hotPadsItems",
        "Listing",
        "name",
        "street",
        "city",
        "state",
        "zip",
        "lat",
        "lng",
        "price",
        "numBedrooms",
        "numFullBaths",
        "squareFeet",
        "description",
        "ListingPhoto",
        "contactEmail",
        "contactPhone",
        "availableOn",
        "listingUrl",
      ].sort(),
    );
  });

  it("carries every mapped field through with the right values", () => {
    const { xml } = buildZillowRentalFeedXml([projectedListing()], "https://prop-lane.space");
    expect(xml).toContain('<Listing id="prop-1" type="RENTAL" companyId="mgr-1" propertyType="house">');
    expect(xml).toContain("<street>123 Main St</street>");
    expect(xml).toContain("<city>Ballard</city>");
    expect(xml).toContain("<state>WA</state>");
    expect(xml).toContain("<zip>98107</zip>");
    expect(xml).toContain("<price>2200</price>");
    expect(xml).toContain("<numBedrooms>3</numBedrooms>");
    expect(xml).toContain("<numFullBaths>2</numFullBaths>");
    expect(xml).toContain("<squareFeet>1200</squareFeet>");
    expect(xml).toContain('<ListingPhoto source="https://cdn.proplane.test/photo1.jpg"/>');
    expect(xml).toContain("<listingUrl>https://prop-lane.space/rent/listings/prop-1</listingUrl>");
  });

  it("never emits houseVideoDataUrl even when the projected submission carries one", () => {
    const withVideo = projectedListing({
      listingSubmission: {
        ...projectedListing().listingSubmission,
        houseVideoDataUrl: "https://cdn.proplane.test/house-walkthrough.mp4",
      } as ManagerListingSubmissionV1,
    });
    const { xml, includedIds } = buildZillowRentalFeedXml([withVideo], "https://prop-lane.space");
    expect(includedIds).toEqual(["prop-1"]);
    expect(xml).not.toContain("house-walkthrough.mp4");
    expect(elementNames(xml)).not.toContain("video");
  });

  it("excludes a listing with no street address, and records why — never a placeholder", () => {
    const { xml, includedIds, excluded } = buildZillowRentalFeedXml(
      [projectedListing({ address: "" })],
      "https://prop-lane.space",
    );
    expect(includedIds).toEqual([]);
    expect(excluded).toEqual([{ propertyId: "prop-1", reasons: ["no_street_address"] }]);
    expect(xml).not.toContain("<Listing");
  });

  it("excludes a listing with no real photo (whole-home or per-room)", () => {
    const noHousePhotos = projectedListing({
      listingSubmission: { ...projectedListing().listingSubmission, housePhotoDataUrls: [] } as ManagerListingSubmissionV1,
    });
    const { includedIds, excluded } = buildZillowRentalFeedXml([noHousePhotos], "https://prop-lane.space");
    expect(includedIds).toEqual([]);
    expect(excluded).toEqual([{ propertyId: "prop-1", reasons: ["no_photo"] }]);
  });

  it("falls back to a by-room listing's cheapest priced room and its photos", () => {
    const byRoom = projectedListing({
      listingSubmission: {
        ...projectedListing().listingSubmission,
        listingPlaceCategoryId: "shared_home",
        housePhotoDataUrls: [],
        rooms: [
          { id: "r1", monthlyRent: 900, photoDataUrls: ["https://cdn.proplane.test/room1.jpg"] },
          { id: "r2", monthlyRent: 750, photoDataUrls: [] },
        ],
      } as unknown as ManagerListingSubmissionV1,
    });
    const { xml, excluded } = buildZillowRentalFeedXml([byRoom], "https://prop-lane.space");
    expect(excluded).toEqual([]);
    expect(xml).toContain('propertyType="apartment"');
    expect(xml).toContain("<price>750</price>");
    expect(xml).toContain('<ListingPhoto source="https://cdn.proplane.test/room1.jpg"/>');
  });

  it("escapes XML special characters in both text content and attributes", () => {
    const tricky = projectedListing({
      title: 'The "Cove" & Sons <House>',
      listingSubmission: {
        ...projectedListing().listingSubmission,
        houseOverview: "Rooms & baths, \"quiet\" street <block>",
        housePhotoDataUrls: ["https://cdn.proplane.test/a.jpg?x=1&y=2"],
      } as ManagerListingSubmissionV1,
    });
    const { xml } = buildZillowRentalFeedXml([tricky], "https://prop-lane.space");
    // XML text content only requires escaping `&`, `<`, `>` — a literal quote is
    // valid there. Attribute values are the stricter case, asserted separately.
    expect(xml).toContain('<name>The "Cove" &amp; Sons &lt;House&gt;</name>');
    expect(xml).toContain('<description>Rooms &amp; baths, "quiet" street &lt;block&gt;</description>');
    expect(xml).toContain('source="https://cdn.proplane.test/a.jpg?x=1&amp;y=2"');
    expect(xml).not.toContain("<block>");
    expect(xml).not.toContain("<House>");
  });

  it("uses only the work contact — never the manager's personal email", () => {
    const { xml } = buildZillowRentalFeedXml([projectedListing()], "https://prop-lane.space");
    expect(xml).toContain("<contactEmail>leasing@proplane.test</contactEmail>");
    expect(xml).not.toContain("personal@example.com");
  });

  it("omits contact elements entirely rather than falling back to another field", () => {
    const noContact = projectedListing({ contactWorkEmail: undefined, contactSmsPhone: undefined });
    const { xml } = buildZillowRentalFeedXml([noContact], "https://prop-lane.space");
    expect(xml).not.toContain("<contactEmail>");
    expect(xml).not.toContain("<contactPhone>");
  });
});
