import { renderProPortalSection } from "@/lib/render-portal-section/manager";

/** Portfolio schedule grid — no sub-path segment (Bookings is `/portal/bookings`). */
export default async function CalendarIndexPage() {
  return renderProPortalSection("calendar");
}
