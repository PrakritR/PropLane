"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { buildThreeDayArrivalAgenda } from "@/lib/manager-arrivals-agenda";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { airbnbBookingEntries, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

function pacificToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ManagerArrivalsDeparturesPanel() {
  const [startDate, setStartDate] = useState(() => pacificToday());
  const [bookings, setBookings] = useState<PropertyBookingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchManagerChannelBookings([])
      .then((properties) => {
        if (!cancelled) setBookings(airbnbBookingEntries(properties));
      })
      .catch(() => {
        if (!cancelled) setBookings([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agenda = useMemo(() => buildThreeDayArrivalAgenda(bookings, startDate), [bookings, startDate]);

  return (
    <div className="space-y-4" data-attr="manager-arrivals-departures">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => setStartDate(shiftDateKey(startDate, -3))}>
          Previous 3 days
        </Button>
        <Button type="button" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => setStartDate(pacificToday())}>
          Today
        </Button>
        <Button type="button" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => setStartDate(shiftDateKey(startDate, 3))}>
          Next 3 days
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-muted">Loading stays…</p>
      ) : (
        agenda.map((day) => (
          <section key={day.dateKey} className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{day.dateLabel}</h2>
            {day.events.length === 0 ? (
              <PortalListEmptyCard title="No arrivals or departures" workspaceAware={false} dataAttr="arrivals-day-empty" />
            ) : (
              day.events.map((event) => (
                <PortalServiceRecordRow
                  key={event.id}
                  title={event.title}
                  subtitle={[event.kind === "check-in" ? "IN · Check-in" : "OUT · Check-out", event.place, ...event.facts].join(" · ")}
                  onOpen={() => {}}
                  dataAttr="arrivals-departure-row"
                />
              ))
            )}
          </section>
        ))
      )}
    </div>
  );
}
