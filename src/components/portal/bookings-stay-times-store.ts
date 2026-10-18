import { DEFAULT_PROPERTY_STAY_TIMES, normalizePropertyStayTimes, type PropertyStayTimes } from "@/lib/bookings/stay-times";
import { getPropertyById } from "@/lib/rental-application/data";

/**
 * A property's stay-time defaults from the client listing store (`listingSubmission.stayTimes`). A listing that has
 * never set them, or an id the store does not know, reads 3:00 pm / 11:00 am with a 3 h cleaning buffer.
 */
export function propertyStayTimesFor(propertyId: string): PropertyStayTimes {
  const submission = getPropertyById(propertyId)?.listingSubmission as { stayTimes?: unknown } | null | undefined;
  return submission?.stayTimes ? normalizePropertyStayTimes(submission.stayTimes) : DEFAULT_PROPERTY_STAY_TIMES;
}
