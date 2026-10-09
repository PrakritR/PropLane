import { PublicListingPageClient } from "@/components/marketing/public-listing-page-client";
import { ListingSourceCapture } from "@/components/marketing/listing-source-capture";

export default function PublicListingPage() {
  return (
    <>
      <ListingSourceCapture />
      <PublicListingPageClient />
    </>
  );
}
