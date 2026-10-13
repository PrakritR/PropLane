"use client";

import { useCallback } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { BlockDatesDraft, BlockDatesSaveResult } from "@/components/portal/bookings-block-dates-modal";
import { saveRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";
import { sendBookingResidentInviteRequest } from "@/lib/booking-resident-invite-client";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

/**
 * The one save path for a booking hold: Bookings and Quick book (from an application) both
 * go through it, so a new resident gets the same invite either way.
 */
export function useSaveBookingBlock({
  userId,
  propertyOptions,
}: {
  userId: string | null;
  propertyOptions: readonly ManagerPropertyFilterOption[];
}) {
  const { showToast } = useAppUi();
  return useCallback(
    async (draft: BlockDatesDraft): Promise<BlockDatesSaveResult> => {
      if (!userId) throw new Error("Sign in again to block dates.");
      const saved = await saveRoomDateBlock(userId, draft);
      // A brand-new resident on a fresh hold gets an invite — the link that
      // creates their account and skips application/lease
      // (src/lib/booking-resident-invite.server.ts). Editing an existing
      // hold, or holding for no one / an existing pick, never re-invites.
      if (draft.isNewResident && (draft.residentEmail || draft.residentPhone)) {
        const property = propertyOptions.find((option) => option.id === draft.propertyId);
        const invite = await sendBookingResidentInviteRequest({
          blockId: saved.id,
          propertyId: draft.propertyId,
          propertyLabel: property?.label ?? "",
          residentName: draft.residentName,
          residentEmail: draft.residentEmail,
          residentPhone: draft.residentPhone ?? "",
        });
        if (invite.ok) {
          showToast(`Held for ${draft.residentName}.`);
          return { message: invite.message };
        }
        showToast(`Held for ${draft.residentName} — ${invite.error}`);
        return { message: `Booking added, but the invite didn’t go out: ${invite.error}` };
      }
      showToast(draft.bookingStatus === "cancelled" ? "Booking cancelled." : draft.id ? "Booking saved." : draft.residentName ? `Held for ${draft.residentName}.` : "Dates blocked.");
    },
    [userId, showToast, propertyOptions],
  );
}
