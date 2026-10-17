/**
 * Listing facts for promotion copy — enriches sparse flyer inputs from the
 * property record so text generation stays grounded in real listing data.
 */

import type { MockProperty } from "@/data/types";
import { buildManagerTourUrl, cleanPropertyDisplayName } from "@/lib/manager-property-links";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { sanitizeFlyerImages, type PromotionInputs } from "@/lib/promotion-flyer";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

export type PromotionDraftAutofillFields = {
  propertyLabel: string;
  address: string;
  headline: string;
  sellingPoints: string;
  customDetails: string;
  price: string;
  promo: string;
  cta: string;
  contact: string;
  schedulingUrl: string;
  includeSchedulingLink: boolean;
  images: string[];
};

const DEFAULT_PROMOTION_CTA = "Schedule a tour";

export type PromotionListingFacts = {
  propertyName: string;
  buildingName: string;
  address: string;
  neighborhood: string;
  unitLabel: string;
  bedsBaths: string;
  rent: string;
  availability: string;
  petFriendly: string;
  tagline: string;
  overview: string;
  amenities: string[];
  listingType: string;
  roomHighlights: string[];
  leaseNotes: string;
};

function splitLineList(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstBundlePromo(property: MockProperty): string {
  const promo = (property.listingSubmission?.bundles ?? [])
    .map((b) => b.promo?.trim())
    .find(Boolean);
  return promo ?? "";
}

function promotionPropertyLabel(property: MockProperty): string {
  const name = cleanPropertyDisplayName(property);
  const place = property.neighborhood.trim() || property.address.trim();
  return place ? `${name} — ${place}` : name;
}

/** Source-field mapping for property → promotion draft autofill. */
export function buildPromotionDraftAutofill(
  property: MockProperty,
  opts?: { managerContact?: string; appOrigin?: string },
): PromotionDraftAutofillFields {
  const facts = extractPromotionListingFacts(property);
  const origin = (opts?.appOrigin ?? "").trim() || (typeof window !== "undefined" ? window.location.origin : "");
  const schedulingUrl = origin ? buildManagerTourUrl(origin, property.id) : "";
  const inputs = enrichPromotionInputsFromListing(
    {
      headline: "",
      sellingPoints: "",
      price: "",
      promo: "",
      cta: DEFAULT_PROMOTION_CTA,
      contact: opts?.managerContact?.trim() ?? "",
      tone: "",
      address: "",
      customDetails: "",
      schedulingUrl,
      includeSchedulingLink: Boolean(schedulingUrl),
    },
    property,
  );
  const images = sanitizeFlyerImages(property.listingSubmission?.housePhotoDataUrls ?? []);

  return {
    propertyLabel: promotionPropertyLabel(property),
    address: inputs.address ?? facts.address,
    headline: inputs.headline,
    sellingPoints: inputs.sellingPoints,
    customDetails: inputs.customDetails,
    price: inputs.price,
    promo: firstBundlePromo(property),
    cta: DEFAULT_PROMOTION_CTA,
    contact: opts?.managerContact?.trim() ?? "",
    schedulingUrl,
    includeSchedulingLink: Boolean(schedulingUrl),
    images,
  };
}

/** Fill empty promotion draft fields from listing data (never overwrites manager edits). */
export function enrichPromotionDraftFromListing<T extends PromotionDraftAutofillFields>(
  draft: T,
  property: MockProperty | null | undefined,
  opts?: { managerContact?: string },
): T {
  if (!property) return draft;
  const source = buildPromotionDraftAutofill(property, opts);
  const fill = (current: string, next: string) => (current.trim() ? current : next);
  return {
    ...draft,
    propertyLabel: fill(draft.propertyLabel, source.propertyLabel),
    address: fill(draft.address, source.address),
    headline: fill(draft.headline, source.headline),
    sellingPoints: fill(draft.sellingPoints, source.sellingPoints),
    customDetails: fill(draft.customDetails, source.customDetails),
    price: fill(draft.price, source.price),
    promo: fill(draft.promo, source.promo),
    cta: fill(draft.cta, source.cta),
    contact: fill(draft.contact, source.contact),
    schedulingUrl: fill(draft.schedulingUrl ?? "", source.schedulingUrl),
    includeSchedulingLink: draft.includeSchedulingLink ?? source.includeSchedulingLink,
    images: draft.images.length ? draft.images : source.images.length ? source.images : draft.images,
  };
}

export function extractPromotionListingFacts(property: MockProperty): PromotionListingFacts {
  // Every field is optional-in-practice: legacy/imported/externally-seeded rows
  // can miss any of them, and a missing field must not crash the portal.
  const sub = property.listingSubmission;
  const rooms = (sub?.rooms ?? []).filter((r) => r.name?.trim());
  const roomHighlights = rooms.slice(0, 8).map((r) => {
    const rent = r.monthlyRent > 0 ? `${formatRoomPriceAmount(r.monthlyRent)}/mo` : "";
    const avail = r.availability?.trim();
    return [r.name?.trim(), rent, avail].filter(Boolean).join(" — ");
  });

  const amenities = splitLineList(sub?.amenitiesText ?? "");
  const beds = property.beds ?? 0;
  const listingType = sub
    ? isEntireHomeListing(sub)
      ? "Entire home"
      : rooms.length > 1
        ? "Rooms for rent"
        : "Rental listing"
    : beds > 0
      ? "Rental listing"
      : "";

  const propertyName = property.buildingName?.trim() || property.title?.trim() || "";
  const overview = sub?.houseOverview?.trim() || "";

  return {
    propertyName,
    buildingName: property.buildingName?.trim() ?? "",
    address: property.address?.trim() ?? "",
    neighborhood: property.neighborhood?.trim() ?? "",
    unitLabel: property.unitLabel?.trim() ?? "",
    bedsBaths: beds > 0 ? `${beds} bed · ${property.baths ?? 0} bath` : "",
    rent: property.rentLabel?.trim() ?? "",
    availability: property.available?.trim() ?? "",
    petFriendly: property.petFriendly ? "Pet friendly" : "",
    tagline: property.tagline?.trim() || overview.split(/\n/)[0]?.trim() || "",
    overview,
    amenities,
    listingType,
    roomHighlights,
    leaseNotes: sub?.leaseTermsBody?.trim().slice(0, 400) || "",
  };
}

/** Multi-line block for AI prompts — only facts from the listing record. */
export function formatPromotionListingContext(property: MockProperty): string {
  const f = extractPromotionListingFacts(property);
  return [
    `Property name: ${f.propertyName || "(none)"}`,
    f.buildingName && f.buildingName !== f.propertyName ? `Building: ${f.buildingName}` : "",
    f.address ? `Address: ${f.address}` : "",
    f.neighborhood ? `Neighborhood: ${f.neighborhood}` : "",
    f.unitLabel ? `Unit: ${f.unitLabel}` : "",
    f.listingType ? `Listing type: ${f.listingType}` : "",
    f.bedsBaths ? `Size: ${f.bedsBaths}` : "",
    f.rent ? `Rent: ${f.rent}` : "",
    f.availability ? `Availability: ${f.availability}` : "",
    f.petFriendly ? `Pet policy: ${f.petFriendly}` : "",
    f.tagline ? `Tagline: ${f.tagline}` : "",
    f.overview ? `House overview: ${f.overview}` : "",
    f.amenities.length ? `Amenities: ${f.amenities.join("; ")}` : "",
    f.roomHighlights.length ? `Rooms: ${f.roomHighlights.join(" | ")}` : "",
    f.leaseNotes ? `Lease notes: ${f.leaseNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Fill empty promotion inputs from listing data (never overwrites manager edits). */
export function enrichPromotionInputsFromListing(
  inputs: PromotionInputs,
  property: MockProperty | null | undefined,
): PromotionInputs {
  if (!property) return inputs;

  const facts = extractPromotionListingFacts(property);
  const sellingLines = [
    facts.bedsBaths,
    facts.petFriendly,
    facts.tagline,
    ...facts.amenities.slice(0, 5),
    ...facts.roomHighlights.slice(0, 4),
  ].filter(Boolean);

  const detailParts = [
    facts.overview,
    facts.neighborhood ? `Neighborhood: ${facts.neighborhood}` : "",
    facts.listingType ? `Listing type: ${facts.listingType}` : "",
    facts.roomHighlights.length ? `Rooms: ${facts.roomHighlights.join("; ")}` : "",
    facts.leaseNotes ? `Lease: ${facts.leaseNotes}` : "",
  ].filter(Boolean);

  return {
    ...inputs,
    address: inputs.address?.trim() || facts.address || inputs.address,
    headline: inputs.headline.trim() || facts.tagline || facts.propertyName || inputs.headline,
    price: inputs.price.trim() || facts.rent || inputs.price,
    sellingPoints: inputs.sellingPoints.trim() || sellingLines.join("\n") || inputs.sellingPoints,
    customDetails: inputs.customDetails.trim() || detailParts.join("\n\n") || inputs.customDetails,
  };
}
