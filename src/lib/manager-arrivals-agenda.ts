import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

export type ArrivalDepartureEvent = {
  id: string;
  kind: "check-in" | "check-out";
  dateKey: string;
  dateLabel: string;
  title: string;
  place: string;
  facts: string[];
  bookingHref?: string;
};

function pacificDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

export function buildThreeDayArrivalAgenda(
  bookings: readonly PropertyBookingEntry[],
  startDateKey: string = pacificDateKey(new Date()),
): { dateKey: string; dateLabel: string; events: ArrivalDepartureEvent[] }[] {
  const days = [0, 1, 2].map((offset) => {
    const dateKey = addDays(startDateKey, offset);
    return { dateKey, dateLabel: formatDateLabel(dateKey) };
  });

  return days.map(({ dateKey, dateLabel }) => {
    const events: ArrivalDepartureEvent[] = [];
    for (const b of bookings) {
      if (b.source === "block" || b.source === "hold") continue;
      const place = [b.propertyLabel, b.roomLabel].filter(Boolean).join(" · ");
      const stayFacts: string[] = [];
      const sd = b.stayDetails;
      if (sd?.linen) stayFacts.push(`Linen ${sd.linen}`);
      if (sd?.baggage) stayFacts.push(`Baggage ${sd.baggage}`);
      if (sd?.earlyCheckIn) stayFacts.push(`Early ${sd.earlyCheckIn}`);
      if (sd?.lateCheckOut) stayFacts.push(`Late ${sd.lateCheckOut}`);

      if (b.start === dateKey) {
        events.push({
          id: `${b.propertyId}-${b.roomId}-${b.start}-in`,
          kind: "check-in",
          dateKey,
          dateLabel,
          title: b.summary,
          place,
          facts: [b.statusLabel ? b.statusLabel : "Check-in", ...stayFacts],
        });
      }
      if (b.end === dateKey) {
        events.push({
          id: `${b.propertyId}-${b.roomId}-${b.end}-out`,
          kind: "check-out",
          dateKey,
          dateLabel,
          title: b.summary,
          place,
          facts: ["Check-out", ...stayFacts],
        });
      }
    }
    events.sort((a, b) => a.title.localeCompare(b.title));
    return { dateKey, dateLabel, events };
  });
}
