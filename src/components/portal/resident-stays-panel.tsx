"use client";

/**
 * Resident portal › Stays: a guest's own short stays, Upcoming | Past (a route each). The list is the
 * Properties list anatomy (`PortalRecordListSurface`): tile · title · place line · glyph facts · figure ·
 * the per-row ⋯ menu. No status pill - the fact line says Requested (with the hours left on the host's 24),
 * Approved (pay now, while the stay's charge is unpaid), Confirmed, Completed, Declined or Expired. The band's
 * round + and a row's "Request again" open the booking application (`/stays/request`) with the house and
 * room prefilled; an approved row's "Pay now" opens Payments. See docs/agents/bookings.md § Guest portal stays.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, CalendarX, Clock, CreditCard, Luggage, Moon, Users } from "lucide-react";
import { StayTimesSheet } from "@/components/portal/stay-times-sheet";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { formatStayMoment } from "@/lib/bookings/stay-times";
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
import { parseStayAddOnLink, type StayAddOnLink } from "@/lib/short-stay/stay-add-ons";
import { stayRequestHref } from "@/lib/short-stay/stay-request-link";
import { usePortalNavigate } from "@/lib/portal-nav-client";
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
  if (stay.status === "confirmed" && stay.payment === "due") return CreditCard;
  if (stay.status === "confirmed") return CalendarCheck;
  if (stay.status === "pending") return Clock;
  return CalendarX;
}

export function ResidentStaysPanel({ basePath = "/resident", bucket = "upcoming" }: { basePath?: string; bucket?: GuestStayBucket }) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const navigate = usePortalNavigate();
  // The Check-in and checkout sheet, opened from a stay's ⋯ menu or by the text link (`?stay=&addOn=&time=`).
  const [timesSheet, setTimesSheet] = useState<{ stay: GuestStay; link: StayAddOnLink | null } | null>(null);
  const linkHandled = useRef(false);
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

  // The pay link in the guest's text lands here: open that stay's sheet, preselected, once the list is in.
  useEffect(() => {
    if (list.status !== "ready" || linkHandled.current || typeof window === "undefined") return;
    linkHandled.current = true;
    const link = parseStayAddOnLink(window.location.search);
    const target = link ? list.stays.find((candidate) => candidate.id === link.stayId) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot open from the URL after the list loads
    if (link && target && (target.status === "confirmed" || target.status === "pending")) setTimesSheet({ stay: target, link });
  }, [list]);

  // Back from Stripe: the webhook moves the stay's time a moment after the payment, so look again a few times.
  useEffect(() => {
    if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("ach_checkout") !== "success") return;
    const timers = [4000, 10000].map((delay) => window.setTimeout(() => void load(), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [load]);
  const counts = useMemo(
    () => ({
      upcoming: stays.filter((stay) => guestStayBucket(stay, today) === "upcoming").length,
      past: stays.filter((stay) => guestStayBucket(stay, today) === "past").length,
    }),
    [stays, today],
  );
  const rows = useMemo(() => sortGuestStays(stays.filter((stay) => guestStayBucket(stay, today) === bucket), bucket), [stays, today, bucket]);
  // The round + opens the booking application at the house of the newest stay that can still be booked.
  const seedStay = useMemo(() => [...stays].sort((a, b) => b.checkIn.localeCompare(a.checkIn)).find((stay) => stay.canBookAgain) ?? null, [stays]);
  const requestAgain = (stay: GuestStay) =>
    navigate(stayRequestHref({ listing: stay.propertyId, room: stay.roomId, guests: stay.guests }, basePath));
  const payNow = () => navigate(`${basePath}/payments/pending`);

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
              onClick={() => requestAgain(seedStay)}
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
          // An upcoming stay prints its real times ("Oct 16, 3:00 pm → Oct 19, 11:00 am"); a past one, its dates.
          const place =
            bucket === "upcoming" && stay.checkInTime && stay.checkOutTime
              ? `${formatStayMoment(stay.checkIn, stay.checkInTime)} → ${formatStayMoment(stay.checkOut, stay.checkOutTime)}`
              : `${shortStayDayLabel(stay.checkIn)} → ${shortStayDayLabel(stay.checkOut)}`;
          const bookAgain = stay.canBookAgain ? () => requestAgain(stay) : undefined;
          const pay = stay.status === "confirmed" && stay.payment === "due" && bucket === "upcoming" ? payNow : undefined;
          const openTimes = bucket === "upcoming" && (stay.status === "confirmed" || stay.status === "pending") ? () => setTimesSheet({ stay, link: null }) : undefined;
          return (
            <RecordActionContext.Provider
              key={stay.id}
              value={{
                scope: stay.id,
                clear: () => {},
                actions:
                  bookAgain || openTimes || pay ? (
                    <>
                      {pay ? (
                        <Button data-attr="resident-stay-menu-pay" onClick={pay}>
                          <CreditCard className="size-4 shrink-0" aria-hidden />
                          Pay now
                        </Button>
                      ) : null}
                      {openTimes ? (
                        <Button data-attr="resident-stay-menu-times" onClick={openTimes}>
                          <Clock className="size-4 shrink-0" aria-hidden />
                          Check-in and checkout
                        </Button>
                      ) : null}
                      {bookAgain ? (
                        <Button data-attr="resident-stay-menu-book-again" onClick={bookAgain}>
                          Request again
                        </Button>
                      ) : null}
                    </>
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
                onOpen={pay ?? (bucket === "past" ? bookAgain : undefined)}
                onSelectedChange={() => {}}
                omitActionView
                selectLabel={`${stay.propertyLabel} ${stay.roomLabel} ${place}`}
                dataAttr="resident-stay-row"
              />
            </RecordActionContext.Provider>
          );
        })}
      </PortalRecordListSurface>
      {timesSheet ? (
        <StayTimesSheet
          stay={timesSheet.stay}
          preselect={timesSheet.link}
          onClose={() => {
            // The link has done its job: drop it so a refresh does not reopen the sheet.
            if (timesSheet.link && typeof window !== "undefined") window.history.replaceState(null, "", window.location.pathname);
            setTimesSheet(null);
          }}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
