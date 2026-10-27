import { renderPortalSection, type PortalSearchParams } from "@/lib/render-portal-section/resident";

/**
 * The short-stay request. A static segment so it outranks `applications/[bucket]`, and it reads the query
 * (`?listing=&room=&checkIn=&checkOut=&guests=`) the request form is prefilled from.
 */
export default async function ResidentApplicationsStayPage({
  searchParams,
}: {
  searchParams: Promise<PortalSearchParams>;
}) {
  return renderPortalSection("resident", "applications", ["stay"], await searchParams);
}
