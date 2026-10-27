"use client";

import { useMemo } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  CHANNEL_LINK_PROVIDER_LABELS,
  channelLinkProviderForSource,
  linkForRange,
  linkTargetsRange,
  reservationOptionsForStay,
  type ChannelLink,
} from "@/lib/channel-calendar/channel-link";
import { addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";
import { lastNightBeforeCheckout, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const NOT_LINKED = "";

const shortDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : key;
};

/** "HMRRN4XTZ8 · Oct 3 – Nov 3 · Room 7": the reservation's code, its dates (check-out shown) and its room. */
export function reservationOptionLabel(entry: Pick<PropertyBookingEntry, "reservationCode" | "guestName" | "summary" | "start" | "end" | "roomLabel">): string {
  const who = entry.guestName?.trim();
  const id = entry.reservationCode?.trim() || (who ? "" : entry.summary?.trim() ?? "");
  return [who, id, `${shortDay(entry.start)} – ${shortDay(addDaysToDateKey(entry.end, 1))}`, entry.roomLabel].filter(Boolean).join(" · ");
}

/**
 * The reservation picker under Source: when Source is Airbnb or Booking.com it lists that room's reservations
 * from the channel calendar (closest dates first) and linking one says "this stay IS that reservation".
 * Renders nothing for any other Source or for a whole-home stay (a reservation belongs to a room).
 */
export function BookingChannelLinkField({
  source,
  entries,
  propertyId,
  roomId,
  checkIn,
  checkOut,
  link,
  onChange,
  disabled,
  labelClassName,
}: {
  source: string | undefined;
  entries: readonly PropertyBookingEntry[];
  propertyId: string;
  roomId: string;
  checkIn: string;
  /** Exclusive check-out, as the sheets hold it. */
  checkOut: string;
  link: ChannelLink | undefined;
  onChange: (next: ChannelLink | undefined) => void;
  disabled?: boolean;
  labelClassName?: string;
}) {
  const provider = channelLinkProviderForSource(source);
  const options = useMemo(() => {
    if (!provider || !propertyId || !roomId) return [];
    return reservationOptionsForStay(entries, {
      provider,
      propertyId,
      roomId,
      start: checkIn || "9999-01-01",
      end: checkOut && checkOut > checkIn ? lastNightBeforeCheckout(checkOut) : checkIn || "9999-01-01",
    });
  }, [provider, entries, propertyId, roomId, checkIn, checkOut]);
  if (!provider || !roomId) return null;
  const keyOf = (entry: PropertyBookingEntry) => `${entry.connectionId ?? ""}|${entry.sourceUid ?? entry.reservationCode ?? ""}`;
  const current = link && link.provider === provider ? options.find((entry) => linkTargetsRange(link, { provider: entry.source, sourceUid: entry.sourceUid, reservationCode: entry.reservationCode })) : undefined;
  const value = current ? keyOf(current) : link && link.provider === provider ? "__stored__" : NOT_LINKED;
  const choices = [
    { value: NOT_LINKED, label: "Not linked" },
    ...(value === "__stored__" ? [{ value: "__stored__", label: link?.reservationCode ?? "Linked reservation" }] : []),
    ...options.map((entry) => ({ value: keyOf(entry), label: reservationOptionLabel(entry) })),
  ];
  return (
    <FieldSingleSelect
      labelClassName={labelClassName}
      label={`${CHANNEL_LINK_PROVIDER_LABELS[provider]} reservation`}
      dataAttr="select-booking-channel-link"
      disabled={disabled}
      value={value}
      onChange={(next) => {
        if (next === "__stored__") return;
        const picked = options.find((entry) => keyOf(entry) === next);
        onChange(picked ? linkForRange({ provider, sourceUid: picked.sourceUid, reservationCode: picked.reservationCode }) : undefined);
      }}
      options={choices}
    />
  );
}
