"use client";

/**
 * Short stays on the resident Application page (captain, Oct 27: no Stays tab - "same UI for both short term and
 * long term applications"). `useResidentGuestStays` loads the guest's own stays (bounded: a hung request shows
 * the error and Try again instead of skeletons for good) and `ResidentStayApplicationRows` draws the ones in one
 * section as the same `PortalApplicantRecordRow` an application is: house · room, "Short stay · dates · nights",
 * the amount, the per-row ⋯ - no pill. Which section a stay is in is `guestStaySectionOf`
 * (`src/lib/short-stay/guest-stay-application.ts`). The ⋯ offers Pay now (an approved, unpaid stay), Check-in
 * and checkout (`StayTimesSheet`) and Request again. See docs/agents/bookings.md § Guest portal stays.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, CreditCard, DoorOpen, Luggage, Users, CalendarCheck, CalendarX } from "lucide-react";
import { ResidentStayCheckIn } from "@/components/portal/resident-check-in-guide";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { StayTimesSheet } from "@/components/portal/stay-times-sheet";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { fetchGuestStays, GUEST_STAYS_CHANGED } from "@/lib/short-stay/guest-stays-client";
import { guestStayStatusLabel, type GuestStay } from "@/lib/short-stay/guest-stays";
import {
  guestStayFigure,
  guestStayPlaceLine,
  guestStayRowActions,
  guestStayTitle,
} from "@/lib/short-stay/guest-stay-application";
import { parseStayAddOnLink, type StayAddOnLink } from "@/lib/short-stay/stay-add-ons";
import { stayRequestHref } from "@/lib/short-stay/stay-request-link";
import { usePortalNavigate } from "@/lib/portal-nav-client";

export type GuestStaysState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; stays: GuestStay[] };

export type ResidentGuestStays = {
  state: GuestStaysState;
  stays: GuestStay[];
  reload: () => void;
  /** The Check-in and checkout sheet for the stay a row (or the text link) opened; null when closed. */
  sheet: ReactNode;
  openTimes: (stay: GuestStay) => void;
  /** Opens the numbered Check-in guide for a confirmed stay (`ResidentStayCheckIn`). */
  openGuide: (stay: GuestStay) => void;
};

export function useResidentGuestStays({ enabled = true }: { enabled?: boolean } = {}): ResidentGuestStays {
  // A page with no stays to read (the apply flow, the demo) starts ready and empty, and asks the server nothing.
  const [state, setState] = useState<GuestStaysState>(enabled ? { status: "loading" } : { status: "ready", stays: [] });
  // The Check-in and checkout sheet, opened from a stay's ⋯ menu or by the text link (`?stay=&addOn=&time=`).
  const [timesSheet, setTimesSheet] = useState<{ stay: GuestStay; link: StayAddOnLink | null } | null>(null);
  const [guideStay, setGuideStay] = useState<GuestStay | null>(null);
  const linkHandled = useRef(false);

  const load = useCallback(async () => {
    try {
      setState({ status: "ready", stays: await fetchGuestStays() });
    } catch (caught) {
      setState({ status: "error", message: caught instanceof Error ? caught.message : "Could not load your stays." });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on mount; state is set after the awaited fetch
    void load();
    const refresh = () => void load();
    window.addEventListener(GUEST_STAYS_CHANGED, refresh);
    return () => window.removeEventListener(GUEST_STAYS_CHANGED, refresh);
  }, [enabled, load]);

  const stays = useMemo(() => (state.status === "ready" ? state.stays : []), [state]);

  // The text link lands here: open that stay's sheet, preselected, once the list is in.
  useEffect(() => {
    if (state.status !== "ready" || linkHandled.current || typeof window === "undefined") return;
    linkHandled.current = true;
    const link = parseStayAddOnLink(window.location.search);
    const target = link ? state.stays.find((candidate) => candidate.id === link.stayId) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot open from the URL after the list loads
    if (link && target && (target.status === "confirmed" || target.status === "pending")) setTimesSheet({ stay: target, link });
  }, [state]);

  // Back from Stripe: the webhook moves the stay's time a moment after the payment, so look again a few times.
  useEffect(() => {
    if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("ach_checkout") !== "success") return;
    const timers = [4000, 10000].map((delay) => window.setTimeout(() => void load(), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [load]);

  const guideSheet = guideStay ? (
    <PortalDialog
      open
      onClose={() => setGuideStay(null)}
      title={`Check-in · ${guideStay.roomLabel || guideStay.propertyLabel}`}
      dataAttr="stay-check-in-guide"
      primaryAction={null}
    >
      <ResidentStayCheckIn blockId={guideStay.id} />
    </PortalDialog>
  ) : null;

  const timesSheetNode = timesSheet ? (
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
  ) : null;
  const sheet = (
    <>
      {timesSheetNode}
      {guideSheet}
    </>
  );

  return {
    state,
    stays,
    reload: () => void load(),
    sheet,
    openTimes: (stay) => setTimesSheet({ stay, link: null }),
    openGuide: (stay) => setGuideStay(stay),
  };
}

function statusIcon(stay: GuestStay) {
  if (stay.status === "confirmed" && stay.payment === "due") return CreditCard;
  if (stay.status === "confirmed") return CalendarCheck;
  if (stay.status === "pending") return Clock;
  return CalendarX;
}

/** The stays of one section as application rows (the caller has already filtered and sorted them). */
export function ResidentStayApplicationRows({
  stays,
  today,
  basePath = "/resident",
  onOpenTimes,
  onOpenGuide,
}: {
  stays: readonly GuestStay[];
  /** A Pacific YYYY-MM-DD. */
  today: string;
  basePath?: string;
  onOpenTimes: (stay: GuestStay) => void;
  onOpenGuide?: (stay: GuestStay) => void;
}) {
  const navigate = usePortalNavigate();
  const requestAgain = (stay: GuestStay) =>
    navigate(stayRequestHref({ listing: stay.propertyId, room: stay.roomId, guests: stay.guests }, basePath));
  const payNow = () => navigate(`${basePath}/payments/pending`);

  return (
    <div data-attr="resident-stay-rows">
      {stays.map((stay) => {
        const can = guestStayRowActions(stay, today);
        const Icon = statusIcon(stay);
        const place = guestStayPlaceLine(stay);
        const figure = guestStayFigure(stay);
        const showGuide = can.checkInGuide && Boolean(onOpenGuide);
        const anyAction = can.payNow || can.checkInTimes || can.requestAgain || showGuide;
        return (
          <RecordActionContext.Provider
            key={stay.id}
            value={{
              scope: stay.id,
              clear: () => {},
              actions: anyAction ? (
                <>
                  {can.payNow ? (
                    <Button data-attr="resident-stay-menu-pay" onClick={payNow}>
                      <CreditCard className="size-4 shrink-0" aria-hidden />
                      Pay now
                    </Button>
                  ) : null}
                  {showGuide ? (
                    <Button data-attr="resident-stay-menu-guide" onClick={() => onOpenGuide?.(stay)}>
                      <DoorOpen className="size-4 shrink-0" aria-hidden />
                      Check-in
                    </Button>
                  ) : null}
                  {can.checkInTimes ? (
                    <Button data-attr="resident-stay-menu-times" onClick={() => onOpenTimes(stay)}>
                      <Clock className="size-4 shrink-0" aria-hidden />
                      Check-in times
                    </Button>
                  ) : null}
                  {can.requestAgain ? (
                    <Button data-attr="resident-stay-menu-book-again" onClick={() => requestAgain(stay)}>
                      Request again
                    </Button>
                  ) : null}
                </>
              ) : null,
            }}
          >
            <PortalApplicantRecordRow
              name={guestStayTitle(stay)}
              tileIcon={Luggage}
              address={place}
              facts={
                <>
                  <PortalRowFact icon={Icon} srLabel="Status">
                    {guestStayStatusLabel(stay, today)}
                  </PortalRowFact>
                  {stay.guests > 1 ? (
                    <PortalRowFact icon={Users} srLabel="Guests">
                      {stay.guests} guests
                    </PortalRowFact>
                  ) : null}
                </>
              }
              amount={figure}
              onOpen={can.payNow ? payNow : undefined}
              onSelectedChange={() => {}}
              omitActionView
              selectLabel={`${guestStayTitle(stay)} ${place}`}
              dataAttr="resident-stay-row"
            />
          </RecordActionContext.Provider>
        );
      })}
    </div>
  );
}
