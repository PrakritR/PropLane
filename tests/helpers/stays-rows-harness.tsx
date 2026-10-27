import { ResidentStayApplicationRows, useResidentGuestStays } from "@/components/portal/resident-stay-application-rows";
import { guestStaySectionOf, sortGuestStaysForSection } from "@/lib/short-stay/guest-stay-application";
import type { ResidentApplicationSection } from "@/lib/resident-application-sections";

/**
 * The guest's short stays of one Application section, exactly as the Application page draws them, without the
 * application list around them: the hook that loads (bounded) and the rows, plus the Check-in times sheet.
 */
export function StaysRowsHarness({ section, today = "2026-10-14" }: { section: ResidentApplicationSection; today?: string }) {
  const guest = useResidentGuestStays();
  const stays = sortGuestStaysForSection(guest.stays.filter((stay) => guestStaySectionOf(stay) === section), section);
  return (
    <>
      <div data-attr="harness-state" data-state={guest.state.status} />
      <ResidentStayApplicationRows stays={stays} today={today} onOpenTimes={guest.openTimes} />
      {guest.sheet}
    </>
  );
}
