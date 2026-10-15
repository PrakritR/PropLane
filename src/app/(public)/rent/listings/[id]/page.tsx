import { PublicListingPageClient } from "@/components/marketing/public-listing-page-client";
import { ListingSourceCapture } from "@/components/marketing/listing-source-capture";
import { getCrawlPublicListings } from "@/lib/seo/public-catalog.server";
import { jsonLdString, listingJsonLd } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";

export const revalidate = 3600;

/** Public projection only; any failure renders the page without structured data. */
async function listingStructuredData(id: string): Promise<string | null> {
  try {
    const property = (await getCrawlPublicListings()).find((p) => p.id === id);
    return property ? jsonLdString(listingJsonLd(property, llmsOrigin())) : null;
  } catch {
    return null;
  }
}

export default async function PublicListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jsonLd = await listingStructuredData(id);
  return (
    <>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      <ListingSourceCapture />
      <PublicListingPageClient />
    </>
  );
}
