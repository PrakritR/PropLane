"use client";

import { useEffect, useState } from "react";

import { PORTAL_READ_TIMEOUT_MS, withTimeout } from "@/lib/auth/fetch-with-timeout";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import {
  airbnbBookingEntries,
  importedChannelStayEntries,
  isImportedChannelBlock,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";

/**
 * Every channel stay of these houses as booking entries: the iCal feeds (Airbnb, Booking.com, Vrbo,
 * other calendars) plus the stays a manager imported into the calendar. The Residents list derives
 * its guest rows from these; nothing here writes.
 *
 * Two reads, each capped. A failure is silent on purpose (the list is still the residents; a guest row that does
 * not load is a missing convenience, not a wrong answer) and is retried twice, 15s apart. Keyed on WHICH houses
 * are in scope (the sorted ids), never on the array carrying them, so a portfolio refresh that
 * rebuilds an identical array does not blank the rows and re-ask.
 */
export function useChannelGuestStays({
  enabled,
  propertyIds,
  propertyLabelForId,
  roomLabelForId,
}: {
  enabled: boolean;
  propertyIds: readonly string[];
  propertyLabelForId: (propertyId: string) => string;
  roomLabelForId: (propertyId: string, roomId: string) => string;
}): { entries: PropertyBookingEntry[]; ready: boolean } {
  const key = [...new Set(propertyIds)].filter(Boolean).sort().join("\u0000");
  const [state, setState] = useState<{ key: string; entries: PropertyBookingEntry[] } | null>(null);

  useEffect(() => {
    if (!enabled || !key) return;
    const ids = key.split("\u0000");
    const scoped = new Set(ids);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      void Promise.all([
        withTimeout(fetchManagerChannelBookings(ids), PORTAL_READ_TIMEOUT_MS).catch(() => null),
        withTimeout(fetchRoomDateBlocks(), PORTAL_READ_TIMEOUT_MS).catch(() => null),
      ]).then(([bookings, blocks]) => {
        if (cancelled) return;
        const imported = importedChannelStayEntries(
          (blocks ?? []).filter((block) => scoped.has(block.propertyId) && isImportedChannelBlock(block)),
          { propertyLabelForId, roomLabelForId },
        );
        setState({ key, entries: [...airbnbBookingEntries(bookings ?? []), ...imported] });
        // A read that timed out is asked once more shortly after, so a slow first answer does not leave the
        // list without its guests until the next visit. What did load is drawn in the meantime.
        if ((bookings === null || blocks === null) && attempt < 2) timer = setTimeout(() => load(attempt + 1), 15_000);
      });
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The label resolvers are read when the answer lands; their identity is not a reason to re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return { entries: state && state.key === key ? state.entries : [], ready: Boolean(state && state.key === key) };
}
