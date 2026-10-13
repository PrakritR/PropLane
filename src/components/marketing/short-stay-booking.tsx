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
import { listingContactRows, listingPrimaryCtaClass, listingSecondaryCtaClass } from "@/components/marketing/listing-contact-card";
import { DateField } from "@/components/ui/date-field";
import { Input, Select } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import type { MockProperty } from "@/data/types";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { addRangeDays } from "@/lib/room-availability-range";
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

type ShortStayState = {
  offered: boolean;
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
  // A hold is always on a room, so a listing carrying none has nothing to book: the whole
  // short-stay block stays off the page and the monthly card stands alone, rather than
  // drawing dates, a total and a "Request to book" that can never be pressed.
  const offered = !disabled && listingOffersShortStay(sub) && rooms.length > 0;
  const { rooms: occupancyRows, loading: occupancyLoading } = useListingPublicOccupancy(offered ? property.id : null);
  const [checkIn, setCheckInRaw] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuestsRaw] = useState(1);
  const [roomId, setRoomIdRaw] = useState("");
  const today = pacificTodayKey();

  const check = useMemo(() => validateShortStayDates(checkIn, checkOut, today), [checkIn, checkOut, today]);
  const rangeValid = check.ok;
  const nights = check.ok ? check.nights : 0;

  const setCheckIn = useCallback((value: string) => {
    setCheckInRaw(value);
    // A check-out that is no longer after the new check-in is cleared, never silently moved.
    setCheckOut((current) => (value && current && current <= value ? "" : current));
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

  const verdictFor = useCallback(
    (id: string): ShortStayRoomVerdict | null => {
      if (!offered || !check.ok) return null;
      const room = sub?.rooms?.find((r) => r.id === id);
      if (!room) return null;
      const spans = findPublicRoomOccupancy(occupancyRows, property.id, id)?.spans ?? [];
      return shortStayRoomVerdict({
        spans,
        capacity: room.occupancyCapacity,
        availableFrom: room.moveInAvailableDate,
        checkIn: check.checkIn,
        checkOut: check.checkOut,
      });
    },
    [check, occupancyRows, offered, property.id, sub],
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
    if (new URLSearchParams(window.location.search).get("stay") !== "1") return;
    const timer = window.setTimeout(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('[data-attr="short-stay-check-in"] input[type="text"], [data-attr="short-stay-check-in"] input:not([type])'));
      const visible = inputs.find((input) => input.offsetParent !== null);
      visible?.scrollIntoView({ block: "center", behavior: "smooth" });
      visible?.focus({ preventScroll: true });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [offered]);

  const value = useMemo<ShortStayState>(
    () => ({ offered, property, rooms, checkIn, checkOut, guests, roomId, setCheckIn, setCheckOut, setGuests, setRoomId, rangeValid, nights, occupancyRows, occupancyLoading, verdictFor }),
    [offered, property, rooms, checkIn, checkOut, guests, roomId, setCheckIn, setGuests, setRoomId, rangeValid, nights, occupancyRows, occupancyLoading, verdictFor],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

type SendState = { kind: "idle" } | { kind: "form" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/** The Airbnb-style booking block: nightly price, dates, guests, live total, Request to book, Message. */
export function ShortStayBookingBlock({ className = "" }: { className?: string }) {
  const stay = useShortStay();
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const honeypot = useRef<HTMLInputElement>(null);
  if (!stay || !stay.offered) return null;

  const today = pacificTodayKey();
  const picked = stay.rooms.find((room) => room.id === stay.roomId) ?? null;
  const freeRooms = stay.rangeValid ? stay.rooms.filter((room) => stay.verdictFor(room.id)?.free !== false) : stay.rooms;
  const from = listingShortStayNightlyFrom(stay.property.listingSubmission);
  const nightly = picked?.nightly || from;
  const maxGuests = picked?.capacity ?? Math.max(1, ...stay.rooms.map((room) => room.capacity));
  const total = nightly > 0 && stay.rangeValid ? shortStayTotal(nightly, stay.nights) : 0;
  const contact = listingContactRows(stay.property).phone;
  const noFreeRoom = stay.rangeValid && !stay.occupancyLoading && freeRooms.length === 0;
  const canRequest = stay.rangeValid && Boolean(picked) && !noFreeRoom && total > 0;

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
      <p className="text-xs font-semibold text-muted">{picked || stay.rooms.every((r) => r.nightly === from) ? "Per night" : "Per night from"}</p>
      <p className="mt-0.5 text-3xl font-bold tracking-tight text-foreground" data-attr="short-stay-nightly">
        {nightly > 0 ? `${formatShortStayMoney(nightly)}` : "—"}
        <span className="ml-1 text-sm font-semibold text-muted">/ night</span>
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2" data-attr="short-stay-dates">
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
      {total > 0 ? (
        <p className="mt-3 flex items-baseline justify-between gap-3 text-sm" data-attr="short-stay-total">
          <span className="text-muted">{formatShortStayMoney(nightly)} × {stay.nights} {stay.nights === 1 ? "night" : "nights"}</span>
          <span className="font-bold text-foreground">{formatShortStayMoney(total)}</span>
        </p>
      ) : null}
      {noFreeRoom ? <p className="mt-2 text-sm font-semibold text-foreground" role="status">No room is free for those nights.</p> : null}

      {state.kind === "sent" ? (
        <p className="mt-3 rounded-2xl bg-accent/40 p-3 text-sm font-semibold text-foreground" role="status" data-attr="short-stay-sent">
          Request sent. We texted {phone ? phone : "you"} to confirm.
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
      ) : (
        <button
          type="button"
          className={`${listingPrimaryCtaClass} mt-3 disabled:opacity-50`}
          disabled={!canRequest}
          onClick={() => setState({ kind: "form" })}
          data-attr="short-stay-request"
        >
          Request to book
        </button>
      )}
      {contact ? (
        <a href={contact.smsHref} className={`${listingSecondaryCtaClass} mt-2.5`} data-attr="short-stay-message">
          Message · text {contact.label}
        </a>
      ) : null}
    </div>
  );
}
