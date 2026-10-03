import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { dayStayDisplayName } from "@/lib/occupancy/snapshot";

/** Describes the exact manual booking selected for removal, without guessing cascades. */
export function BookingRemovalPreview({ entry }: { entry: PropertyBookingEntry }) {
  return <span className="grid gap-3 text-sm" data-attr="booking-removal-preview">
    {[
      ["Booking", dayStayDisplayName(entry)],
      ["Property", entry.propertyLabel],
      ["Room", entry.roomLabel || "Whole home"],
      ["Dates", formatBookingStayRange(entry.start, entry.end, entry.openEnded)],
    ].map(([label, value]) => <span key={label} className="flex justify-between gap-4 border-b border-border pb-2"><span className="text-muted">{label}</span><span className="text-right font-medium">{value}</span></span>)}
  </span>;
}
