"use client";

/**
 * Short stays on the public listing, like Airbnb's: dates and guests on the price card, the rooms list
 * narrowed to rooms free for those nights, and "Request to book", which makes a manager hold (nothing is
 * charged). One provider per listing page holds the picked dates / room / guests so the card (rendered in
 * two places by width) and the rooms list always agree. The date rules, rates and per-room verdict are the
 * pure helpers in `src/lib/short-stay-request.ts`; the server re-checks everything.
 */
import { Minus, Plus } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { listingPrimaryCtaClass, listingSecondaryCtaClass, listingTextUsLabel } from "@/components/marketing/listing-contact-card";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { buildSmsDeepLink, listingCtaSmsPhone } from "@/lib/claw-leasing-links";
import { buildProspectBookHref } from "@/lib/prospect-public-nav";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DateField } from "@/components/ui/date-field";
import { Input, Select } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import type { MockProperty } from "@/data/types";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { normalizePropertyStayTimes, stayAddOnLabel, type StayAddOnKind } from "@/lib/bookings/stay-times";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { addRangeDays, normalizeRangeDay } from "@/lib/room-availability-range";
import {
  addOnsQuoteCents,
  estimatedArrivalOptions,
  offersForBooking,
  standardTimesLine,
  stayAddOnCheckLabel,
  type StayAddOnOffer,
} from "@/lib/short-stay/stay-add-ons";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import {
  SHORT_STAY_MAX_DAYS_AHEAD,
  formatShortStayMoney,
  listingOffersShortStay,
  listingShortStayNightlyFrom,
  shortStayRoomNightly,
  shortStayRoomVerdict,
  shortStayTotal,
  validateShortStayDates,
  type ShortStayRoomVerdict,
} from "@/lib/short-stay-request";

type StayRoom = { id: string; name: string; capacity: number; nightly: number };

/** The card's two stays: a monthly lease (Apply / Quick apply) or a short stay (Request to book / Quick book). */
export type StaySegment = "monthly" | "short";

type ShortStayState = {
  offered: boolean;
  segment: StaySegment;
  setSegment: (value: StaySegment) => void;
  /** The monthly segment's optional move-in date. */
  moveIn: string;
  setMoveIn: (value: string) => void;
  property: MockProperty;
  rooms: StayRoom[];
  checkIn: string;
  checkOut: string;
  guests: number;
  roomId: string;
  setCheckIn: (value: string) => void;
  setCheckOut: (value: string) => void;
  setGuests: (value: number) => void;
  setRoomId: (value: string) => void;
  /** True once both dates are a valid range (1 to 28 nights, within 180 days). */
  rangeValid: boolean;
  nights: number;
  occupancyRows: PublicRoomOccupancy[];
  occupancyLoading: boolean;
  verdictFor: (roomId: string) => ShortStayRoomVerdict | null;
};

const Ctx = createContext<ShortStayState | null>(null);

/** The listing's short-stay state, or null outside a provider (the manager preview modal, the demo). */
export function useShortStay(): ShortStayState | null {
  return useContext(Ctx);
}

export function ShortStayProvider({ property, disabled = false, children }: { property: MockProperty; /** A manager's own preview never books: the card keeps its read-only price line. */ disabled?: boolean; children: ReactNode }) {
  const sub = property.listingSubmission;
  const rooms = useMemo<StayRoom[]>(
    () =>
      (sub?.rooms ?? [])
        .filter((room) => room.id)
        .map((room, index) => ({
          id: room.id,
          name: room.name?.trim() || `Room ${index + 1}`,
          capacity: normalizeRoomOccupancyCapacity(room.occupancyCapacity),
          nightly: shortStayRoomNightly(room, sub?.shortTermDailyCost),
        })),
    [sub],
  );
  // THE predicate for "this listing offers a short stay", read by the card's segment control, the
  // phone sticky bar's primary and the booking block alike — one answer, so the bar can never offer
  // "Request to book" for a card that is showing the monthly side.
  //
  // A hold is always on a room, so a listing carrying none has nothing to book; and a night with no
  // nightly rate has no price, so the segment would read "- / night" over a total of nothing. Either
  // way the whole short-stay block stays off the page and the monthly card stands alone, rather than
  // drawing dates, a total and a "Request to book" that can never be pressed.
  const offered =
    !disabled && listingOffersShortStay(sub) && rooms.length > 0 && listingShortStayNightlyFrom(sub) > 0;
  // Read for every listing (not only short-stay ones): the monthly segment dims a room taken on the move-in date too.
  const { rooms: occupancyRows, loading: occupancyLoading } = useListingPublicOccupancy(disabled ? null : property.id);
  const [segment, setSegment] = useState<StaySegment>("monthly");
  const [moveIn, setMoveIn] = useState("");
  const [checkIn, setCheckInRaw] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuestsRaw] = useState(1);
  const [roomId, setRoomIdRaw] = useState("");
  const today = pacificTodayKey();

  const check = useMemo(() => validateShortStayDates(checkIn, checkOut, today), [checkIn, checkOut, today]);
  const rangeValid = check.ok;
  const nights = check.ok ? check.nights : 0;

  const setCheckIn = useCallback((value: string) => {
    setSegment("short");
    setCheckInRaw(value);
    // A check-out that is no longer after the new check-in is cleared, never silently moved.
    setCheckOut((current) => (value && current && current <= value ? "" : current));
  }, []);
  const setCheckOutDay = useCallback((value: string) => {
    setSegment("short");
    setCheckOut(value);
  }, []);
  const clampGuests = useCallback((value: number, forRoom: string) => {
    const capacity = rooms.find((r) => r.id === forRoom)?.capacity ?? Math.max(1, ...rooms.map((r) => r.capacity));
    return Math.min(Math.max(1, Math.round(value) || 1), capacity);
  }, [rooms]);
  const setGuests = useCallback((value: number) => setGuestsRaw(clampGuests(value, roomId)), [clampGuests, roomId]);
  const setRoomId = useCallback((value: string) => {
    setRoomIdRaw(value);
    setGuestsRaw((current) => clampGuests(current, value));
  }, [clampGuests]);

  // The nights the card is currently asking about: the short stay's range, or the monthly move-in day.
  const activeRange = useMemo<{ checkIn: string; checkOut: string } | null>(() => {
    if (segment === "short") return check.ok ? { checkIn: check.checkIn, checkOut: check.checkOut } : null;
    const day = normalizeRangeDay(moveIn);
    return day && day >= today ? { checkIn: day, checkOut: addRangeDays(day, 1) } : null;
  }, [check, moveIn, segment, today]);

  const verdictFor = useCallback(
    (id: string): ShortStayRoomVerdict | null => {
      if (!activeRange || (segment === "short" && !offered)) return null;
      const room = sub?.rooms?.find((r) => r.id === id);
      if (!room) return null;
      const spans = findPublicRoomOccupancy(occupancyRows, property.id, id)?.spans ?? [];
      return shortStayRoomVerdict({
        spans,
        capacity: room.occupancyCapacity,
        availableFrom: room.moveInAvailableDate,
        checkIn: activeRange.checkIn,
        checkOut: activeRange.checkOut,
      });
    },
    [activeRange, occupancyRows, offered, property.id, segment, sub],
  );

  // A picked room that the new dates take away is dropped, so the card never books a taken room.
  useEffect(() => {
    if (!roomId) return;
    const verdict = verdictFor(roomId);
    if (verdict && !verdict.free) setRoomIdRaw("");
  }, [roomId, verdictFor]);

  // One room is not a choice: the room select only renders from two up, so a single-room
  // listing has no control anywhere (least of all on a phone) that could pick it. Hold it
  // for the guest, and let it back in as soon as the dates free it again.
  useEffect(() => {
    if (!offered || roomId || rooms.length !== 1) return;
    const only = rooms[0];
    if (verdictFor(only.id)?.free === false) return;
    setRoomIdRaw(only.id);
    setGuestsRaw((current) => clampGuests(current, only.id));
  }, [clampGuests, offered, roomId, rooms, verdictFor]);

  // `?stay=1` (the short-stay post's link) lands on the date inputs.
  useEffect(() => {
    if (!offered || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("stay") !== "1") return;
    let focusTimer: number | undefined;
    const timer = window.setTimeout(() => {
      setSegment("short");
      // Back from resident sign-up (`buildProspectBookHref`): the picks the guest made before it are still theirs.
      const pickedIn = normalizeRangeDay(params.get("checkIn") ?? "");
      const pickedOut = normalizeRangeDay(params.get("checkOut") ?? "");
      if (pickedIn) setCheckInRaw(pickedIn);
      if (pickedIn && pickedOut && pickedOut > pickedIn) setCheckOut(pickedOut);
      const pickedRoom = params.get("room") ?? "";
      if (pickedRoom && rooms.some((room) => room.id === pickedRoom)) setRoomIdRaw(pickedRoom);
      const pickedGuests = Number(params.get("guests"));
      if (Number.isFinite(pickedGuests) && pickedGuests > 1) setGuestsRaw(clampGuests(pickedGuests, pickedRoom));
      if (pickedIn) {
        focusTimer = window.setTimeout(() => {
          const block = Array.from(document.querySelectorAll<HTMLElement>('[data-attr="short-stay-block"]')).find((node) => node.offsetParent !== null);
          block?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 120);
        return;
      }
      // The short-stay inputs mount with the segment: look for them one beat later.
      focusTimer = window.setTimeout(() => {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-attr="short-stay-check-in"] input[type="text"], [data-attr="short-stay-check-in"] input:not([type])'));
        const visible = inputs.find((input) => input.offsetParent !== null);
        visible?.scrollIntoView({ block: "center", behavior: "smooth" });
        visible?.focus({ preventScroll: true });
      }, 120);
    }, 400);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(focusTimer);
    };
    // Read once, when the offer is known: the URL is the guest's earlier picks, not a live control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered]);

  const value = useMemo<ShortStayState>(
    () => ({ offered, segment, setSegment, moveIn, setMoveIn, property, rooms, checkIn, checkOut, guests, roomId, setCheckIn, setCheckOut: setCheckOutDay, setGuests, setRoomId, rangeValid, nights, occupancyRows, occupancyLoading, verdictFor }),
    [offered, segment, moveIn, property, rooms, checkIn, checkOut, guests, roomId, setCheckIn, setCheckOutDay, setGuests, setRoomId, rangeValid, nights, occupancyRows, occupancyLoading, verdictFor],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

type SendState = { kind: "idle" } | { kind: "form" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/**
 * The Airbnb-style booking block: dates, room, guests, live total, Request to book, and a text link.
 * It is the price card's Short stay segment and nothing else, so it prints no price line of its own —
 * the card's one price line already sits above the segments. `quickBook` is a signed-in resident with
 * saved answers: name, phone and email come from their account and the button reads Quick book.
 */
export function ShortStayBookingBlock({
  className = "",
  quickBook = null,
}: {
  className?: string;
  quickBook?: { name: string; email: string; phone: string } | null;
}) {
  const stay = useShortStay();
  const [state, setState] = useState<SendState>({ kind: "idle" });
  // What the guest typed wins; until they type, the signed-in account's details stand in.
  const [typedName, setName] = useState<string | null>(null);
  const [typedPhone, setPhone] = useState<string | null>(null);
  const [typedEmail, setEmail] = useState<string | null>(null);
  const name = typedName ?? quickBook?.name ?? "";
  const phone = typedPhone ?? quickBook?.phone ?? "";
  const email = typedEmail ?? quickBook?.email ?? "";
  const honeypot = useRef<HTMLInputElement>(null);
  // "none" = Not sure: nothing is sent. Any other value is the "HH:MM" the guest expects to arrive.
  const [arrival, setArrival] = useState(() => {
    if (typeof window === "undefined") return "none";
    const picked = new URLSearchParams(window.location.search).get("arrive") ?? "";
    return /^\d{2}:\d{2}$/.test(picked) ? picked : "none";
  });
  const auth = useProspectContactAutofill();
  const signedInResident = auth.ready && Boolean(auth.userId) && auth.hasResidentRole;
  const publicLine = usePublicTexting().phone;
  const [ticked, setTicked] = useState<StayAddOnKind[]>([]);
  const [offers, setOffers] = useState<StayAddOnOffer[]>([]);
  const pickedRoomId = stay ? (stay.rooms.find((room) => room.id === stay.roomId) ?? (stay.rooms.length === 1 ? stay.rooms[0] : null))?.id ?? "" : "";
  // Which paid add-ons these exact nights could carry is the SERVER's answer (a dry run that writes nothing);
  // an add-on it does not offer is never drawn, and an unreadable answer offers none.
  const dryKey = stay && stay.offered && stay.rangeValid && pickedRoomId ? `${stay.property.id}|${pickedRoomId}|${stay.checkIn}|${stay.checkOut}|${stay.guests}` : "";
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a changed selection clears the previous answer at once
    setOffers([]);
    if (!dryKey) return;
    const [propertyId, roomId, checkIn, checkOut, guests] = dryKey.split("|");
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch("/api/public/short-stay-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, propertyId, roomId, checkIn, checkOut, guests: Number(guests) }),
      })
        .then(async (res) => (res.ok ? ((await res.json()) as { addOns?: StayAddOnOffer[] }) : null))
        .then((body) => {
          if (!cancelled) setOffers(body?.addOns ?? []);
        })
        .catch(() => {
          if (!cancelled) setOffers([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dryKey]);
  if (!stay || !stay.offered) return null;

  const today = pacificTodayKey();
  // A listing with one room has nothing to choose: that room is the one.
  const picked = stay.rooms.find((room) => room.id === stay.roomId) ?? (stay.rooms.length === 1 ? stay.rooms[0]! : null);
  const freeRooms = stay.rangeValid ? stay.rooms.filter((room) => stay.verdictFor(room.id)?.free !== false) : stay.rooms;
  const from = listingShortStayNightlyFrom(stay.property.listingSubmission);
  const nightly = picked?.nightly || from;
  const maxGuests = picked?.capacity ?? Math.max(1, ...stay.rooms.map((room) => room.capacity));
  const stayTotal = nightly > 0 && stay.rangeValid ? shortStayTotal(nightly, stay.nights) : 0;
  const addOnOffers = offersForBooking([offers]);
  const activeAddOns = ticked.filter((kind) => addOnOffers.some((offer) => offer.kind === kind));
  const addOnsCents = addOnsQuoteCents([offers], activeAddOns);
  const total = stayTotal > 0 ? stayTotal + addOnsCents / 100 : 0;
  const times = normalizePropertyStayTimes(stay.property.listingSubmission?.stayTimes);
  const noFreeRoom = stay.rangeValid && !stay.occupancyLoading && freeRooms.length === 0;
  const canRequest = stay.rangeValid && Boolean(picked) && !noFreeRoom && total > 0;
  // Two paths (captain, Oct 20): Request to book makes a resident account first and comes back to this card with the
  // picks in place (a signed-in resident books here), and Text us opens Messages to the listing's number with the
  // same picks written out, for the leasing agent to quote and send the pay link.
  const homeLabel = listingTextUsLabel(stay.property);
  const roomName = picked && stay.rooms.length > 1 ? picked.name : null;
  const textUsHref = homeLabel
    ? buildSmsDeepLink({
        intent: "book",
        toPhone: listingCtaSmsPhone(stay.property.contactSmsPhone) ?? listingCtaSmsPhone(publicLine),
        propertyLabel: homeLabel,
        roomName,
        stay: {
          checkIn: stay.rangeValid ? stay.checkIn : null,
          checkOut: stay.rangeValid ? stay.checkOut : null,
          guests: stay.guests,
          arrival: arrival === "none" ? null : arrival,
        },
      })
    : "#";
  const signUpToBook =
    !signedInResident && !quickBook
      ? buildProspectBookHref(stay.property.id, {
          roomId: picked?.id ?? null,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          guests: stay.guests,
          arrival: arrival === "none" ? null : arrival,
        })
      : null;

  const send = async () => {
    if (!picked || !stay.rangeValid) return;
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/public/short-stay-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId: stay.property.id,
          roomId: picked.id,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          guests: stay.guests,
          name,
          phone,
          email,
          honeypot: honeypot.current?.value ?? "",
          ...(arrival !== "none" ? { estimatedArrival: arrival } : {}),
          ...(activeAddOns.length ? { addOns: activeAddOns } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setState({ kind: "error", message: body.error || "We couldn't send your request. Try again." });
        return;
      }
      setState({ kind: "sent" });
    } catch {
      setState({ kind: "error", message: "We couldn't send your request. Try again." });
    }
  };

  const formOpen = state.kind === "form" || state.kind === "sending" || state.kind === "error";
  const ready = name.trim().length > 0 && phone.trim().length > 0;

  return (
    <div className={className} data-attr="short-stay-block">
      <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2" data-attr="short-stay-dates">
        <label className="block min-w-0 text-xs font-semibold text-muted" data-attr="short-stay-check-in">
          Check-in
          <DateField
            value={stay.checkIn}
            onChange={stay.setCheckIn}
            min={today}
            max={addRangeDays(today, SHORT_STAY_MAX_DAYS_AHEAD)}
            className="mt-1"
            aria-label="Check-in"
          />
        </label>
        <label className="block min-w-0 text-xs font-semibold text-muted" data-attr="short-stay-check-out">
          Check-out
          <DateField
            value={stay.checkOut}
            onChange={stay.setCheckOut}
            min={stay.checkIn ? addRangeDays(stay.checkIn, 1) : addRangeDays(today, 1)}
            max={stay.checkIn ? addRangeDays(stay.checkIn, 28) : undefined}
            className="mt-1"
            aria-label="Check-out"
          />
        </label>
      </div>
      {stay.rooms.length > 1 ? (
        <div className="mt-2.5" data-attr="short-stay-room">
          <Select aria-label="Room" value={stay.roomId} onChange={(e) => stay.setRoomId(e.target.value)}>
            <option value="">Choose a room</option>
            {freeRooms.map((room) => (
              <option key={room.id} value={room.id}>{room.name}</option>
            ))}
          </Select>
        </div>
      ) : null}
      <div className="mt-2.5 flex min-h-[44px] items-center justify-between rounded-2xl border border-border px-4" data-attr="short-stay-guests">
        <span className="text-sm font-semibold text-foreground">Guests</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Fewer guests"
            disabled={stay.guests <= 1}
            onClick={() => stay.setGuests(stay.guests - 1)}
            className="grid size-9 place-items-center rounded-full text-foreground transition hover:bg-foreground/5 disabled:opacity-35"
          >
            <Minus className="size-4" aria-hidden />
          </button>
          <span className="w-6 text-center text-sm font-bold tabular-nums" aria-live="polite">{stay.guests}</span>
          <button
            type="button"
            aria-label="More guests"
            disabled={stay.guests >= maxGuests}
            onClick={() => stay.setGuests(stay.guests + 1)}
            className="grid size-9 place-items-center rounded-full text-foreground transition hover:bg-foreground/5 disabled:opacity-35"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </span>
      </div>
      <p className="mt-3 text-sm font-semibold text-foreground" data-attr="short-stay-standard-times">
        {standardTimesLine(times)}
      </p>
      <div className="mt-2.5" data-attr="short-stay-arrival">
        <FieldSingleSelect
          label="Estimated arrival"
          value={arrival}
          options={[{ value: "none", label: "Not sure" }, ...estimatedArrivalOptions().filter((option) => option.value !== "")]}
          onChange={setArrival}
          dataAttr="short-stay-arrival-select"
        />
      </div>
      {addOnOffers.length > 0 ? (
        <div className="mt-1.5 space-y-0.5" data-attr="short-stay-add-ons">
          {addOnOffers.map((offer) => {
            const label = stayAddOnCheckLabel(offer);
            if (!label) return null;
            return (
              <label key={offer.kind} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-foreground" data-attr={`short-stay-add-on-${offer.kind}`}>
                <input
                  type="checkbox"
                  className="size-5 shrink-0 rounded border-border"
                  checked={activeAddOns.includes(offer.kind)}
                  onChange={(event) =>
                    setTicked((current) => (event.target.checked ? [...new Set([...current, offer.kind])] : current.filter((kind) => kind !== offer.kind)))
                  }
                  aria-label={stayAddOnLabel(offer.kind)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      ) : null}
      {total > 0 ? (
        <p className="mt-3 flex items-baseline justify-between gap-3 text-sm" data-attr="short-stay-total">
          <span className="text-muted">{formatShortStayMoney(nightly)} × {stay.nights} {stay.nights === 1 ? "night" : "nights"}{activeAddOns.length ? ` + ${activeAddOns.map((kind) => stayAddOnLabel(kind).toLowerCase()).join(" + ")}` : ""}</span>
          <span className="font-bold text-foreground">{formatShortStayMoney(total)}</span>
        </p>
      ) : null}
      {noFreeRoom ? <p className="mt-2 text-sm font-semibold text-foreground" role="status">No room is free for those nights.</p> : null}

      {state.kind === "sent" ? (
        <p className="mt-3 rounded-2xl bg-accent/40 p-3 text-sm font-semibold text-foreground" role="status" data-attr="short-stay-sent">
          Request sent. We texted you to confirm.
        </p>
      ) : formOpen ? (
        <div className="mt-3 space-y-2.5" data-attr="short-stay-form">
          <Input aria-label="Your name" placeholder="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <PhoneNumberField value={phone} onChange={setPhone} placeholder="Mobile number" dataAttr="short-stay-phone" />
          <Input aria-label="Email (optional)" placeholder="Email (optional)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="absolute left-[-9999px] h-0 w-0 opacity-0" />
          {state.kind === "error" ? <p className="text-sm font-semibold text-[var(--status-overdue-fg)]" role="alert">{state.message}</p> : null}
          <button type="button" className={listingPrimaryCtaClass} disabled={!ready || state.kind === "sending"} onClick={() => void send()} data-attr="short-stay-send">
            {state.kind === "sending" ? "Sending…" : "Send request"}
          </button>
        </div>
      ) : signUpToBook && canRequest ? (
        <Link href={signUpToBook} prefetch={false} className={`${listingPrimaryCtaClass} mt-3`} data-attr="short-stay-request">
          Request to book
        </Link>
      ) : (
        <button
          type="button"
          className={`${listingPrimaryCtaClass} mt-3 disabled:opacity-50`}
          disabled={!canRequest}
          onClick={() => {
            // Quick book: the account already supplies name and phone, so one tap sends the request.
            if (quickBook && name.trim() && phone.trim()) void send();
            else setState({ kind: "form" });
          }}
          data-attr="short-stay-request"
        >
          {quickBook ? "Quick book" : "Request to book"}
        </button>
      )}
      {textUsHref !== "#" ? (
        <a href={textUsHref} className={`${listingSecondaryCtaClass} mt-2.5`} data-attr="short-stay-text-us">
          Text us
        </a>
      ) : null}
    </div>
  );
}
