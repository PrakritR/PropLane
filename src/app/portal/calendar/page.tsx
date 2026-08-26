import { renderProPortalSection } from "@/lib/portal-section-page";

/** Portfolio schedule grid — no sub-path segment (Bookings is `/portal/bookings`). */
export default async function CalendarIndexPage() {
  return renderProPortalSection("calendar");
}
