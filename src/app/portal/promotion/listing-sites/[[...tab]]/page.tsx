import { renderProPortalSection } from "@/lib/render-portal-section/manager";

/**
 * `/portal/promotion/listing-sites[/<channelId>[/<tab>]]`: a listing site's record page. A static
 * segment, so it outranks `promotion/[assetId]` (which would otherwise read "listing-sites" as an
 * asset id). The bare path redirects to Promotion › Listing sites; an unknown site 404s.
 */
export default async function ListingSitePage({ params }: { params: Promise<{ tab?: string[] }> }) {
  const { tab } = await params;
  return renderProPortalSection("promotion", ["listing-sites", ...(tab ?? [])]);
}
