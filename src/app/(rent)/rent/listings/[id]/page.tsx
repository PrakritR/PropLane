import type { Metadata } from "next";
import { PublicListingPageClient } from "@/components/marketing/public-listing-page-client";
import { ListingSourceCapture } from "@/components/marketing/listing-source-capture";
import { WebChatLauncher } from "@/components/marketing/web-chat-launcher";
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
  // Every listing page names its own canonical: the layout's root canonical ("/") must never leak onto it, not even
  // when the slug index is empty (a failed or slow catalog read) or the listing has no address to build a slug from.
  const slug = resolution.kind === "redirect" ? resolution.slug : resolution.kind === "slug" ? param.trim() : null;
  return { alternates: { canonical: `${llmsOrigin()}${listingPublicPath(param, slug)}` } };
}

/**
 * `/rent/listings/<param>`: the param is a readable address slug (`4709a-8th-ave-ne`) or the property id. Both render
 * the same page. The 308 from an id or a stale slug to the canonical path is issued by the middleware (it keeps the
 * query: `?stay=1`, `?src=`), because reading `searchParams` here would opt this ISR page out of its CDN cache. This page is
 * the fallback when that lookup fails: it renders in place and names the canonical URL.
 */
export default async function PublicListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: param } = await params;
  const resolution = resolveListingParam(await getListingSlugIndex(), param);
  const id = resolution.id;
  const slug = resolution.kind === "slug" ? param.trim() : resolution.kind === "redirect" ? resolution.slug : null;
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
