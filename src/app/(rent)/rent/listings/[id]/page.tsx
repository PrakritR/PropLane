import type { Metadata } from "next";
import { PublicListingPageClient } from "@/components/marketing/public-listing-page-client";
import { ListingSourceCapture } from "@/components/marketing/listing-source-capture";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { getListingSlugIndex } from "@/lib/seo/listing-slugs.server";
import { jsonLdString, listingJsonLd } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";
import { listingPublicPath } from "@/lib/listing-public-path";
import { resolveListingParam } from "@/lib/listing-slug";

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
  const resolution = resolveListingParam(await getListingSlugIndex(), param);
  if (resolution.kind !== "redirect") return {};
  return { alternates: { canonical: `${llmsOrigin()}${listingPublicPath(param, resolution.slug)}` } };
}

/**
 * `/rent/listings/<param>`: the param is a readable address slug (`4709a-8th-ave-ne`) or the property id. Both render
 * the same page. An id is never redirected: a redirect here cannot carry the query (`?stay=1`, `?src=`) without
 * reading `searchParams`, which would opt this ISR page out of its CDN cache, and id links with a query are still sent.
 */
export default async function PublicListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: param } = await params;
  const resolution = resolveListingParam(await getListingSlugIndex(), param);
  const id = resolution.kind === "redirect" ? param.trim() : resolution.id;
  const slug = resolution.kind === "slug" ? param.trim() : resolution.kind === "redirect" ? resolution.slug : null;
  const jsonLd = await listingStructuredData(id, slug);
  return (
    <>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      <ListingSourceCapture />
      <PublicListingPageClient listingId={id} />
    </>
  );
}
