/**
 * Does a Google Calendar event mean the manager is unavailable for a tour?
 *
 * ONE predicate, deliberately in a dependency-free module, because two surfaces
 * have to agree about it: the public booking grid
 * (`/api/public/property-tour-availability`, which subtracts busy time from what
 * a prospect is offered) and the manager's own calendar
 * (`googleCalendarEventsToMeetings` → the "N open" day headers and week badge).
 * When only one side filtered, a declined invite at 2pm vanished from the
 * manager's remaining-capacity count while the public page still sold 2pm.
 *
 * The rules, in order:
 *
 * - **Declined never blocks.** An invite the manager declined is a meeting they
 *   are not attending.
 * - **Out-of-office and focus time always block.** These are Google's own
 *   explicit "I am not available" event types, so they block whatever their
 *   transparency happens to say.
 * - **Free ("transparent") does not block — all-day included.** That is the
 *   manager explicitly marking the time available, and it is the DEFAULT Google
 *   Calendar writes for an all-day entry.
 * - **Everything else blocks.**
 *
 * All-day entries used to block unconditionally, on the reasoning that an all-day
 * entry usually means away. In practice it meant a linked calendar "blocks
 * everything" (AXI-161): birthdays, reminders, bin day and every other all-day
 * note wiped a whole day of tours each, and a manager had no way to say
 * otherwise because the one control Google gives them — Free/Busy — was being
 * ignored on exactly those events. Genuine absences still block: an
 * out-of-office entry is its own event type, and an all-day event the manager
 * marks Busy is opaque and blocks like anything else.
 */
export function googleEventBlocksTours(event: {
  transparency?: string;
  declinedBySelf?: boolean;
  allDay?: boolean;
  eventType?: string;
}): boolean {
  if (event.declinedBySelf) return false;
  if (event.eventType === "outOfOffice" || event.eventType === "focusTime") return true;
  if (event.transparency === "transparent") return false;
  return true;
}
