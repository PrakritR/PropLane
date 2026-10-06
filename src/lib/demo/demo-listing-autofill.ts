/**
 * The property the "Run demo" walkthrough creates through the real listing
 * wizard. Values are deliberately generic placeholders, not an invented
 * building with a plausible name and street address — a visitor watching the
 * tour should never mistake demo scaffolding for a real listing.
 */
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

/** Valid submission for the demo property-creation autoplay (passes wizard validation). */
export function buildDemoPropertyCreationSubmission(): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const roomA = `demo-room-a-${Date.now()}`;
  const roomB = `demo-room-b-${Date.now()}`;
  return normalizeManagerListingSubmissionV1({
    ...base,
    buildingName: "Demo Property",
    address: "100 Example Ave, Seattle, WA",
    zip: "98101",
    neighborhood: "Seattle",
    listingPropertyTypeId: "house",
    listingPlaceCategoryId: "shared_home",
    listingStoriesId: "2",
    listingTotalBathroomsId: "2",
    listingBedroomSlots: 2,
    tagline: "Sample listing created by the PropLane demo walkthrough",
    petFriendly: true,
    houseOverview:
      "Placeholder listing created by the demo walkthrough — every field here is sample text, not a real home.",
    houseRulesText: "Quiet hours 10pm–8am · No smoking indoors · Guests welcome up to 7 nights",
    amenitiesText: "In-unit laundry\nHigh-speed Wi‑Fi\nSecure entry\nBackyard patio",
    applicationFee: "$45.00",
    securityDeposit: "$600.00",
    moveInFee: "$150.00",
    parkingMonthly: "$0.00",
    hoaMonthly: "$0.00",
    otherMonthlyFees: "$0.00",
    monthToMonthSurcharge: "$0.00",
    customLeaseSurcharge: "$0.00",
    allowedLeaseTerms: ["12-Month"],
    axisPaymentsEnabled: true,
    applicationFeeStripeEnabled: true,
    paymentAtSigningIncludes: ["security_deposit", "move_in_fee"],
    houseMoveInAvailableDate: "",
    houseMoveInInstructions: "Keys available from the manager after your listing is approved.",
    rooms: [
      {
        id: roomA,
        name: "Room A",
        floor: "",
        monthlyRent: 1200,
        availability: "Available now",
        moveInAvailableDate: "",
        moveInInstructions: "",
        manualUnavailableRanges: [],
        detail: "",
        furnishing: "Unfurnished",
        roomAmenitiesText: "",
        photoDataUrls: [],
        videoDataUrl: null,
        moveInPhotoDataUrls: [],
        moveInVideoDataUrl: null,
        utilitiesEstimate: "$75",
      },
      {
        id: roomB,
        name: "Room B",
        floor: "",
        monthlyRent: 1150,
        availability: "Available now",
        moveInAvailableDate: "",
        moveInInstructions: "",
        manualUnavailableRanges: [],
        detail: "",
        furnishing: "Unfurnished",
        roomAmenitiesText: "",
        photoDataUrls: [],
        videoDataUrl: null,
        moveInPhotoDataUrls: [],
        moveInVideoDataUrl: null,
        utilitiesEstimate: "$75",
      },
    ],
    bathrooms: [],
    sharedSpaces: [],
    serviceRequestOptions: [],
  });
}
