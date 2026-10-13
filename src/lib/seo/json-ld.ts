import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { RATE_CARD } from "@/lib/billing/rate-card";
import { parseMonthlyRent } from "@/lib/listings-search";
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
    url: `${origin}/pricing`,
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
  return {
    "@context": "https://schema.org",
    "@type": "Accommodation",
    name: property.title,
    url: `${origin}/rent/listings/${encodeURIComponent(property.id)}`,
    ...(property.tagline ? { description: property.tagline } : {}),
    numberOfBedrooms: property.beds,
    numberOfBathroomsTotal: property.baths,
    petsAllowed: property.petFriendly === true,
    address: {
      "@type": "PostalAddress",
      streetAddress: property.address,
      ...(property.zip ? { postalCode: property.zip } : {}),
      ...(property.state ? { addressRegion: property.state } : {}),
      ...(property.neighborhood ? { addressLocality: property.neighborhood } : {}),
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
