import { redirect } from "next/navigation";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";

/**
 * Retired entry: a short stay is a short-term application in the resident
 * portal now (same application -> lease -> payments process as a long stay).
 * Old links and bookmarks land on that application instead of a second
 * booking flow.
 */
export default async function ShortStayPage({
  searchParams,
}: {
  searchParams: Promise<{ propertyId?: string; roomId?: string }>;
}) {
  const params = await searchParams;
  const propertyId = params.propertyId?.trim() ?? "";
  if (!propertyId) redirect("/rent/browse");
  redirect(
    buildRentalApplyHref({
      propertyId,
      listingRoomId: params.roomId?.trim() || undefined,
      rentalType: "short_term",
    }),
  );
}
