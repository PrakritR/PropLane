import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { parseMonthlyRent } from "@/lib/listings-search";
import { listingSubmissionStreetLine } from "@/lib/manager-listing-submission";
import { LLMS_SUMMARY } from "@/lib/seo/llms";
import type { MockProperty } from "@/data/types";

/** Serialize for an inline <script type="application/ld+json">: `<` is escaped so no field can close the tag. */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Only profiles PropLane owns and that exist in the repo. The marketing footer
 * links no social accounts, so the App Store listing is the one sameAs entry.
 */
export function proplaneSameAs(appStoreUrl: string): string[] {
  return /^https:\/\/apps\.apple\.com\//.test(appStoreUrl) ? [appStoreUrl] : [];
}

export function homeJsonLd(origin: string = PRODUCTION_APP_ORIGIN, appStoreUrl = ""): Record<string, unknown> {
  const sameAs = proplaneSameAs(appStoreUrl);
  const money = (cents: number) => (cents / 100).toFixed(2);
  const offer = (name: string, cents: number) => ({
    "@type": "Offer",
    name,
    price: money(cents),
    priceCurrency: "USD",
    url: `${origin}/#pricing`,
  });
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "PropLane",
        url: `${origin}/`,
        logo: `${origin}/brand/proplane-mark.svg`,
        ...(sameAs.length ? { sameAs } : {}),
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${origin}/#software`,
        name: "PropLane",
        url: `${origin}/`,
        description: LLMS_SUMMARY,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web, iOS",
        publisher: { "@id": `${origin}/#organization` },
        offers: [
          offer("Free", RATE_CARD.free.floorMonthlyCents),
          offer("Pro (monthly)", RATE_CARD.pro.floorMonthlyCents),
          offer("Business (monthly)", RATE_CARD.business.floorMonthlyCents),
        ],
      },
    ],
  };
}

/** Public projection fields only: title, street/zip, rent label, availability. No contact, owner or workspace ids. */
export function listingJsonLd(property: MockProperty, origin: string = PRODUCTION_APP_ORIGIN): Record<string, unknown> {
  const rent = parseMonthlyRent(property.rentLabel ?? "");
  const available = (property.available ?? "").trim();
  const availableNow = /^(now|available|immediately)/i.test(available);
  // `property_data` is a manager-owned blob that `asProperty` only validates for identity, so every
  // fact below is published only when it is actually there and of the right type. A crawler reading
  // `petsAllowed: false` off an unanswered question is a fabricated listing fact.
  const submission = property.listingSubmission?.v === 1 ? property.listingSubmission : undefined;
  // A PostalAddress is a formal address: the locality is the legal city, never the browse-only
  // neighborhood label (`listingSubmissionCityStateLine`).
  const city = submission?.city?.trim() ?? "";
  const region = (submission?.state?.trim() || property.state?.trim() || "").toUpperCase();
  // The stored address normally ends in its own ", City, ST ZIP". `streetAddress` is the street
  // line alone (the decision `listingSubmissionStreetLine` already owns for leases), or a crawler
  // reads the city, state and ZIP once in it and again beside it.
  const street = submission ? listingSubmissionStreetLine({ ...submission, address: property.address }) || property.address : property.address;
  return {
    "@context": "https://schema.org",
    "@type": "Accommodation",
    name: property.title,
    url: `${origin}/rent/listings/${encodeURIComponent(property.id)}`,
    ...(property.tagline ? { description: property.tagline } : {}),
    ...(typeof property.beds === "number" ? { numberOfBedrooms: property.beds } : {}),
    ...(typeof property.baths === "number" ? { numberOfBathroomsTotal: property.baths } : {}),
    ...(typeof property.petFriendly === "boolean" ? { petsAllowed: property.petFriendly } : {}),
    address: {
      "@type": "PostalAddress",
      streetAddress: street,
      ...(property.zip ? { postalCode: property.zip } : {}),
      ...(region ? { addressRegion: region } : {}),
      ...(city ? { addressLocality: city } : {}),
      addressCountry: "US",
    },
    ...(rent !== null
      ? {
          offers: {
            "@type": "Offer",
            price: String(rent),
            priceCurrency: "USD",
            priceSpecification: { "@type": "UnitPriceSpecification", price: String(rent), priceCurrency: "USD", unitText: "MONTH" },
            availability: availableNow ? "https://schema.org/InStock" : "https://schema.org/PreOrder",
            url: `${origin}/rent/listings/${encodeURIComponent(property.id)}`,
          },
        }
      : {}),
  };
}
