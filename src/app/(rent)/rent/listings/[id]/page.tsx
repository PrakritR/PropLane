import type { Metadata } from "next";
import { PublicListingPageClient } from "@/components/marketing/public-listing-page-client";
import { ListingSourceCapture } from "@/components/marketing/listing-source-capture";
import { WebChatLauncher } from "@/components/marketing/web-chat-launcher";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { resolvePublicListingParam } from "@/lib/seo/listing-slugs.server";
import { jsonLdString, listingJsonLd } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";
import { listingPublicPath } from "@/lib/listing-public-path";

export const revalidate = 3600;

/** Public projection only; any failure renders the page without structured data. */
async function listingStructuredData(id: string, slug: string | null): Promise<string | null> {
  try {
    const property = (await getCrawlPublicListings()).find((p) => p.id === id);
    return property ? jsonLdString(listingJsonLd(property, llmsOrigin(), slug)) : null;
  } catch {
    return null;
  }
}

/** The address URL is canonical; an id URL (every link sent before slugs existed) points crawlers at it. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id: param } = await params;
  const resolution = await resolvePublicListingParam(param);
  // Every listing page names its own canonical: the layout's root canonical ("/") must never leak onto it, not even
  // when nothing could resolve the param or the listing has no address to build a slug from.
  const slug = resolution.kind === "stale" ? resolution.slug : resolution.kind === "slug" ? param.trim() : null;
  return { alternates: { canonical: `${llmsOrigin()}${listingPublicPath(param, slug)}` } };
}

/**
 * `/rent/listings/<param>`: the param is a readable address slug (`4709a-8th-ave-ne`), the property id, or a slug
 * minted before a rename. All three render THIS page for the listing the param resolves to - there is no redirect
 * hop - and `generateMetadata` names the canonical readable URL, which is what every link the product prints uses
 * and what a crawler indexes.
 */
export default async function PublicListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: param } = await params;
  const resolution = await resolvePublicListingParam(param);
  const id = resolution.id;
  const slug = resolution.kind === "slug" ? param.trim() : resolution.kind === "stale" ? resolution.slug : null;
  const jsonLd = await listingStructuredData(id, slug);
  return (
    <>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      <ListingSourceCapture />
      <PublicListingPageClient listingId={id} />
      <WebChatLauncher propertyId={id} />
    </>
  );
}
