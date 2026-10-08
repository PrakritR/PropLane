/**
 * Where you live (step 3): the previous address is only asked of someone who has lived at their current address
 * for less than two years. Pure, so the form, the review and the server validator agree.
 */
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";

export const PREVIOUS_ADDRESS_YEARS = 2;

/**
 * True when a previous address should be asked: the move-in date at the current address is unknown, or is less
 * than two years ago. A move-in date two or more years back (or today's date minus two years exactly) means the
 * current address already covers the rental history that is asked for.
 */
export function previousAddressApplies(
  form: { currentMoveIn: string },
  now: Date = new Date(),
): boolean {
  const movedIn = parseFlexibleLocalDate(form.currentMoveIn);
  if (!movedIn) return true;
  const cutoff = new Date(now.getFullYear() - PREVIOUS_ADDRESS_YEARS, now.getMonth(), now.getDate());
  return movedIn.getTime() > cutoff.getTime();
}

/** The previous address needs filling in: it applies and the applicant has not said there is none. */
export function previousAddressRequired(
  form: { currentMoveIn: string; noPreviousAddress: boolean },
  now: Date = new Date(),
): boolean {
  return previousAddressApplies(form, now) && !form.noPreviousAddress;
}
