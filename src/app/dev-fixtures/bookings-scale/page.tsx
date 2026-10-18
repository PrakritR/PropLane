import { notFound } from "next/navigation";
import { BookingsScaleFixture } from "./fixture-client";

/**
 * Dev-only proof page for the Bookings timeline at scale: 100 houses x 10 rooms and ~2,000 stays, supplied
 * through the timeline's injection props so nothing touches the listing store or the database.
 * It lives outside `/demo` because that whole route redirects home. 404s everywhere except `next dev`.
 */
export default function BookingsScalePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <BookingsScaleFixture />;
}
