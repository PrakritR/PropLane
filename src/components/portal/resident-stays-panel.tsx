"use client";

/**
 * Resident portal › Stays: a guest's own short stays, Upcoming | Past (a route each). The list is the
 * Properties list anatomy (`PortalRecordListSurface`): tile · title · place line · glyph facts · figure ·
 * the per-row ⋯ menu. No status pill - the fact line says Confirmed, Pending (with the hours left on the
 * host's 24), Completed, Declined or Expired. A past row (and the band's round +) opens the Book again
 * sheet with its room prefilled. See docs/agents/bookings.md § Guest portal stays.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarCheck, CalendarX, Clock, Luggage, Moon, Users } from "lucide-react";
import { BookAgainSheet } from "@/components/portal/book-again-sheet";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { pacificTodayKey } from "@/lib/room-availability-range";
import { fetchGuestStays, GUEST_STAYS_CHANGED } from "@/lib/short-stay/guest-stays-client";
import {
  GUEST_STAY_BUCKETS,
  guestStayBucket,
  guestStayStatusLabel,
  sortGuestStays,
  type GuestStay,
  type GuestStayBucket,
} from "@/lib/short-stay/guest-stays";
import { formatShortStayMoney, shortStayDayLabel } from "@/lib/short-stay-request";

const BUCKET_LABELS: Record<GuestStayBucket, string> = { upcoming: "Upcoming", past: "Past" };

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; stays: GuestStay[] };

export function guestStaysListHref(basePath: string, bucket: GuestStayBucket): string {
  return `${basePath}/stays/${bucket}`;
}

function statusIcon(stay: GuestStay) {
  if (stay.status === "confirmed") return CalendarCheck;
  if (stay.status === "pending") return Clock;
  return CalendarX;
}

export function ResidentStaysPanel({ basePath = "/resident", bucket = "upcoming" }: { basePath?: string; bucket?: GuestStayBucket }) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [sheet, setSheet] = useState<{ seed: GuestStay | null } | null>(null);
  const today = pacificTodayKey();

  const load = useCallback(async () => {
    try {
      setList({ status: "ready", stays: await fetchGuestStays() });
    } catch (caught) {
      setList({ status: "error", message: caught instanceof Error ? caught.message : "Could not load your stays." });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on mount; state is set after the awaited fetch
    void load();
    const refresh = () => void load();
    window.addEventListener(GUEST_STAYS_CHANGED, refresh);
    return () => window.removeEventListener(GUEST_STAYS_CHANGED, refresh);
  }, [load]);

  const stays = useMemo(() => (list.status === "ready" ? list.stays : []), [list]);
  const counts = useMemo(
    () => ({
      upcoming: stays.filter((stay) => guestStayBucket(stay, today) === "upcoming").length,
      past: stays.filter((stay) => guestStayBucket(stay, today) === "past").length,
    }),
    [stays, today],
  );
  const rows = useMemo(() => sortGuestStays(stays.filter((stay) => guestStayBucket(stay, today) === bucket), bucket), [stays, today, bucket]);
  // The round + books another stay at the house of the newest stay that can still be booked.
  const seedStay = useMemo(() => [...stays].sort((a, b) => b.checkIn.localeCompare(a.checkIn)).find((stay) => stay.canBookAgain) ?? null, [stays]);

  const destinations = GUEST_STAY_BUCKETS.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    count: counts[id],
    href: guestStaysListHref(basePath, id),
    dataAttr: `resident-stays-tab-${id}`,
  }));

  return (
    <div className="min-w-0 space-y-3" data-attr="resident-stays-section" data-stays-bucket={bucket}>
      <PortalListControlStack
        variant="command"
        stickyDestinations
        destinationAriaLabel="Stays"
        activeDestinationId={bucket}
        destinations={destinations}
        primary={
          seedStay ? (
            <PortalPrimaryIconAction
              label={portalListAddPrimaryLabel("stay")}
              onClick={() => setSheet({ seed: seedStay })}
              data-attr="resident-stays-add"
            />
          ) : undefined
        }
      />
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        loading={list.status === "loading"}
        loadError={list.status === "error" ? "Couldn't load your stays" : undefined}
        onRetry={() => void load()}
        emptyCard={{
          title: bucket === "upcoming" ? "No upcoming stays" : "No past stays",
          section: "stays",
          sibling:
            bucket === "upcoming" && counts.past > 0
              ? { label: `${counts.past} past`, href: guestStaysListHref(basePath, "past") }
              : null,
          actions: [{ label: "Find a room", href: "/rent", icon: null }],
        }}
        dataAttr="resident-stays-list"
      >
        {rows.map((stay) => {
          const Icon = statusIcon(stay);
          const place = `${shortStayDayLabel(stay.checkIn)} → ${shortStayDayLabel(stay.checkOut)}`;
          const bookAgain = stay.canBookAgain ? () => setSheet({ seed: stay }) : undefined;
          return (
            <RecordActionContext.Provider
              key={stay.id}
              value={{
                scope: stay.id,
                clear: () => {},
                actions: bookAgain ? (
                  <Button data-attr="resident-stay-menu-book-again" onClick={bookAgain}>
                    Book again
                  </Button>
                ) : null,
              }}
            >
              <PortalEntryRow
                tile={{ kind: "glyph", icon: Luggage }}
                title={`${stay.propertyLabel} · ${stay.roomLabel}`}
                place={place}
                facts={[
                  { icon: Moon, label: `${stay.nights} ${stay.nights === 1 ? "night" : "nights"}` },
                  { icon: Icon, label: guestStayStatusLabel(stay, today) },
                  ...(stay.guests > 1 ? [{ icon: Users, label: `${stay.guests} guests` }] : []),
                ]}
                figure={stay.total != null ? { value: formatShortStayMoney(stay.total) } : undefined}
                onOpen={bucket === "past" ? bookAgain : undefined}
                onSelectedChange={() => {}}
                omitActionView
                selectLabel={`${stay.propertyLabel} ${stay.roomLabel} ${place}`}
                dataAttr="resident-stay-row"
              />
            </RecordActionContext.Provider>
          );
        })}
      </PortalRecordListSurface>
      {sheet ? (
        <BookAgainSheet
          stays={stays}
          seed={sheet.seed}
          onClose={() => setSheet(null)}
          onBooked={() => {
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
