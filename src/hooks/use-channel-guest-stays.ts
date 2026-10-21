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
 * Two reads, each capped, and a failure is silent on purpose: the list is still the residents, and
 * a guest row that does not load is a missing convenience, not a wrong answer. Keyed on WHICH houses
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
    void Promise.all([
      withTimeout(fetchManagerChannelBookings(ids), PORTAL_READ_TIMEOUT_MS).catch(() => []),
      withTimeout(fetchRoomDateBlocks(), PORTAL_READ_TIMEOUT_MS).catch(() => []),
    ]).then(([bookings, blocks]) => {
      if (cancelled) return;
      const imported = importedChannelStayEntries(
        blocks.filter((block) => scoped.has(block.propertyId) && isImportedChannelBlock(block)),
        { propertyLabelForId, roomLabelForId },
      );
      setState({ key, entries: [...airbnbBookingEntries(bookings), ...imported] });
    });
    return () => {
      cancelled = true;
    };
    // The label resolvers are read when the answer lands; their identity is not a reason to re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return { entries: state && state.key === key ? state.entries : [], ready: Boolean(state && state.key === key) };
}
