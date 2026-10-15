"use client";

/**
 * Book again: the popup (New property wizard standard) a guest books another stay from. The room is
 * prefilled from their last stay; two quick picks (Tomorrow · 1 night, Next week · 3 nights) or a
 * calendar with the taken nights crossed out add a stay to the cart, and "Add another stay" stacks more
 * date ranges in the same request - each is its own stay with its own outcome.
 *
 * What the primary button says is the SERVER's answer, not a guess: every change to the cart asks
 * `POST /api/resident/stays` with `dryRun: true`, which runs the real checks (availability, the instant-book
 * rule) and writes nothing. "Confirm stay" = every range is bookable now; "Request to book" = the host
 * answers within 24 hours; "Confirm and request" = a mix. A night taken between that check and the tap is
 * a 409 on that range alone: the sheet keeps the cart and marks the range. See docs/agents/bookings.md
 * § Guest portal stays.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { PopupSubjectCard } from "@/components/portal/popup-live-preview";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Select } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import { addRangeDays, pacificTodayKey, rangeDaysBetween } from "@/lib/room-availability-range";
import {
  fetchBookableListing,
  GUEST_STAYS_CHANGED,
  GuestStaysError,
  postGuestStays,
  type BookableListing,
} from "@/lib/short-stay/guest-stays-client";
import {
  SHORT_STAY_MAX_RANGES,
  guestBookAction,
  guestBookActionLabel,
  guestBookSummaryLine,
  shortStayQuickPicks,
  shortStayRangesOverlap,
  type GuestRangeResult,
  type GuestStay,
  type ShortStayRangeDraft,
} from "@/lib/short-stay/guest-stays";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";
import {
  SHORT_STAY_MAX_DAYS_AHEAD,
  SHORT_STAY_MAX_NIGHTS,
  formatShortStayMoney,
  shortStayDayLabel,
  shortStayTotal,
} from "@/lib/short-stay-request";

type Dry = { status: "idle" | "checking" | "ready" | "error"; results: GuestRangeResult[]; message: string };

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta, 1);
  return date.toISOString().slice(0, 10);
}

function monthLabel(month: string): string {
  return new Date(`${month}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function rangeKey(range: ShortStayRangeDraft): string {
  return `${range.checkIn}|${range.checkOut}`;
}

/** The nights of a calendar month as a Sunday-first grid; leading blanks are null. */
function monthCells(month: string): Array<string | null> {
  const first = new Date(`${month}T12:00:00Z`);
  const lead = first.getUTCDay();
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => addRangeDays(month, i))];
}

export function BookAgainSheet({
  stays,
  seed,
  onClose,
  onBooked,
}: {
  stays: readonly GuestStay[];
  seed: GuestStay | null;
  onClose: () => void;
  onBooked: () => void;
}) {
  const today = pacificTodayKey();
  const lastBookableDay = addRangeDays(today, SHORT_STAY_MAX_DAYS_AHEAD);

  const houses = useMemo(() => {
    const seen = new Map<string, string>();
    for (const stay of stays) if (stay.canBookAgain && !seen.has(stay.propertyId)) seen.set(stay.propertyId, stay.propertyLabel);
    return [...seen].map(([id, label]) => ({ id, label }));
  }, [stays]);

  const [propertyId, setPropertyId] = useState(seed?.propertyId ?? houses[0]?.id ?? "");
  const [listing, setListing] = useState<BookableListing | null>(null);
  const [listingState, setListingState] = useState<"loading" | "ready" | "error">("loading");
  const [roomId, setRoomId] = useState(seed?.roomId ?? "");
  const [guests, setGuests] = useState(Math.max(1, seed?.guests ?? 1));
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [month, setMonth] = useState(monthStart(addRangeDays(today, 1)));
  const [cart, setCart] = useState<ShortStayRangeDraft[]>([]);
  const [dry, setDry] = useState<Dry>({ status: "idle", results: [], message: "" });
  const [phase, setPhase] = useState<"edit" | "result">("edit");
  const [outcome, setOutcome] = useState<GuestRangeResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checkId = useRef(0);
  // The room the house switch lands on, for the clamp below: the effect runs before `setRoomId` has
  // taken, so its own `roomId` is still the previous house's room.
  const roomIdRef = useRef(roomId);
  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  // The house's rooms and whether this guest would be confirmed at once.
  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on house change; state is set after the awaited fetch
    setListingState("loading");
    void fetchBookableListing(propertyId)
      .then((next) => {
        if (cancelled) return;
        setListing(next);
        setListingState(next ? "ready" : "error");
        if (next) {
          const chosen = next.rooms.some((room) => room.id === roomIdRef.current) ? roomIdRef.current : (next.rooms[0]?.id ?? "");
          roomIdRef.current = chosen;
          setRoomId(chosen);
          const sleeps = next.rooms.find((room) => room.id === chosen)?.sleeps;
          setGuests((current) => Math.min(Math.max(1, current), sleeps ?? current));
        }
      })
      .catch(() => {
        if (!cancelled) setListingState("error");
      });
    return () => {
      cancelled = true;
    };
    // The room is read through the ref only, to keep it and the guest count on the new house; a room
    // change re-clamps below.
  }, [propertyId]);

  const room = listing?.rooms.find((candidate) => candidate.id === roomId) ?? null;
  const sleeps = room?.sleeps ?? 1;
  const { rooms: occupancyRows } = useListingPublicOccupancy(propertyId || null);
  const spans = useMemo(() => findPublicRoomOccupancy(occupancyRows, propertyId, roomId)?.spans ?? [], [occupancyRows, propertyId, roomId]);

  /** A night is taken when one more guest-night would overfill the room. */
  const nightTaken = (night: string) => !shortStayRangeHasRoom(spans, sleeps, night, addRangeDays(night, 1));
  const rangeFree = (range: ShortStayRangeDraft) => {
    for (let night = range.checkIn; night < range.checkOut; night = addRangeDays(night, 1)) if (nightTaken(night)) return false;
    return true;
  };

  // Ask the server what the button should say whenever the cart, room or head-count changes.
  const cartKey = cart.map(rangeKey).join(",");
  useEffect(() => {
    if (phase !== "edit" || !propertyId || !roomId || cart.length === 0) {
      checkId.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a cleared cart clears the server's answer
      setDry({ status: "idle", results: [], message: "" });
      return;
    }
    const id = ++checkId.current;
    setDry((current) => ({ ...current, status: "checking" }));
    const timer = window.setTimeout(() => {
      void postGuestStays({ propertyId, roomId, ranges: cart, guests, dryRun: true })
        .then((response) => {
          if (id === checkId.current) setDry({ status: "ready", results: response.results, message: "" });
        })
        .catch((caught: unknown) => {
          if (id !== checkId.current) return;
          const refused = caught instanceof GuestStaysError ? caught.results : null;
          setDry({
            status: refused ? "ready" : "error",
            results: refused ?? [],
            message: caught instanceof Error ? caught.message : "Couldn't check those dates.",
          });
        });
    }, 250);
    return () => window.clearTimeout(timer);
    // `cart` is represented by cartKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, propertyId, roomId, guests, cartKey]);

  const draft: ShortStayRangeDraft | null = checkIn && checkOut && checkOut > checkIn ? { checkIn, checkOut } : null;
  const draftNights = draft ? rangeDaysBetween(draft.checkIn, draft.checkOut) : 0;
  const draftProblem = !draft
    ? ""
    : draft.checkIn < today
      ? "Check-in can't be in the past."
      : draft.checkIn > lastBookableDay
        ? `Check-in must be within ${SHORT_STAY_MAX_DAYS_AHEAD} days.`
        : draftNights > SHORT_STAY_MAX_NIGHTS
          ? `Stays are ${SHORT_STAY_MAX_NIGHTS} nights at most.`
          : !rangeFree(draft)
            ? "Some of those nights are taken."
            : cart.some((range) => shortStayRangesOverlap(range, draft))
              ? "Those dates are already in this request."
              : "";

  const addToCart = (range: ShortStayRangeDraft) => {
    setCart((current) => (current.length >= SHORT_STAY_MAX_RANGES ? current : [...current, range]));
    setCheckIn("");
    setCheckOut("");
    setError("");
  };

  const pickDay = (day: string) => {
    setError("");
    if (!checkIn || checkOut || day <= checkIn) {
      setCheckIn(day);
      setCheckOut("");
      return;
    }
    setCheckOut(day);
  };

  const quickPick = (pick: { checkIn: string; checkOut: string }) => {
    const range = { checkIn: pick.checkIn, checkOut: pick.checkOut };
    setMonth(monthStart(range.checkIn));
    if (!rangeFree(range) || cart.some((existing) => shortStayRangesOverlap(existing, range))) {
      setCheckIn(range.checkIn);
      setCheckOut(range.checkOut);
      return;
    }
    addToCart(range);
  };

  const results = dry.results;
  const resultFor = (range: ShortStayRangeDraft) => results.find((r) => r.checkIn === range.checkIn && r.checkOut === range.checkOut);
  const action = guestBookAction(results);
  const refusedRanges = results.filter((r) => r.outcome === "unavailable" || r.outcome === "invalid");
  const total = cart.reduce((sum, range) => sum + shortStayTotal(room?.nightly ?? 0, rangeDaysBetween(range.checkIn, range.checkOut)), 0);

  const submit = async () => {
    if (busy || cart.length === 0 || !room) return;
    setBusy(true);
    setError("");
    try {
      const response = await postGuestStays({ propertyId, roomId, ranges: cart, guests });
      window.dispatchEvent(new Event(GUEST_STAYS_CHANGED));
      onBooked();
      // What went through leaves the cart; a range refused at the last moment stays, marked.
      const refused = response.results.filter((r) => r.outcome === "unavailable" || r.outcome === "invalid");
      setCart(refused.map((r) => ({ checkIn: r.checkIn, checkOut: r.checkOut })));
      setOutcome(response.results);
      setPhase("result");
    } catch (caught) {
      if (caught instanceof GuestStaysError && caught.results) {
        // Every range refused (a night went between the check and the tap): keep the cart, mark the ranges.
        setDry({ status: "ready", results: caught.results, message: "" });
        setError(caught.status === 409 ? "Someone just booked those nights. Pick other dates." : caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not save your booking.");
      }
    } finally {
      setBusy(false);
    }
  };

  const checking = dry.status === "checking";
  const canSubmit = phase === "edit" && cart.length > 0 && dry.status === "ready" && action !== "none" && refusedRanges.length === 0 && !busy;
  const primaryLabel = phase === "result" ? "Done" : checking ? "Checking" : cart.length === 0 ? "Book" : guestBookActionLabel(action);
  const calendarDays = monthCells(month);
  const selecting = Boolean(checkIn && !checkOut);

  /** Calendar day state: taken nights are crossed out; while choosing a check-out, days past the first taken night are closed. */
  const dayState = (day: string): { disabled: boolean; taken: boolean } => {
    const taken = nightTaken(day);
    if (day < today || day > lastBookableDay) return { disabled: true, taken: false };
    if (!selecting) return { disabled: taken, taken };
    if (day <= checkIn) return { disabled: taken, taken };
    return { disabled: !rangeFree({ checkIn, checkOut: day }) || rangeDaysBetween(checkIn, day) > SHORT_STAY_MAX_NIGHTS, taken };
  };

  const preview = (
    <PreviewPanel
      title="Stay"
      name={listing?.propertyLabel ?? "Book again"}
      sub={room ? `${room.label} · ${formatShortStayMoney(room.nightly)} / night` : undefined}
      facts={[
        { label: "Stays", value: cart.length ? String(cart.length) : "None yet", warn: cart.length === 0 },
        { label: "Guests", value: String(guests) },
        { label: "Nights", value: String(cart.reduce((sum, range) => sum + rangeDaysBetween(range.checkIn, range.checkOut), 0)) },
        { label: "Total", value: formatShortStayMoney(total) },
      ]}
    />
  );

  const content =
    phase === "result" ? (
      <div className="space-y-3" data-attr="book-again-result">
        <p className="text-[15px] font-semibold text-foreground">{guestBookSummaryLine(outcome) || "Nothing was booked"}</p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {outcome.map((row) => (
            <li key={rangeKey(row)} className="flex items-center justify-between gap-3 px-3.5 py-3 text-[14px]" data-outcome={row.outcome}>
              <span className="min-w-0">
                {shortStayDayLabel(row.checkIn)} → {shortStayDayLabel(row.checkOut)}
                {row.nights ? ` · ${row.nights} ${row.nights === 1 ? "night" : "nights"}` : ""}
              </span>
              <span className={row.outcome === "unavailable" || row.outcome === "invalid" ? "shrink-0 font-medium text-danger" : "shrink-0 font-medium text-foreground"}>
                {row.outcome === "confirmed" ? "Confirmed" : row.outcome === "pending" ? "Pending, the host has 24 hours" : row.error ?? "Not available"}
              </span>
            </li>
          ))}
        </ul>
        {cart.length > 0 ? (
          <Button type="button" variant="outline" onClick={() => setPhase("edit")} data-attr="book-again-fix-dates">
            Choose other dates
          </Button>
        ) : null}
      </div>
    ) : (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-attr="book-again-form">
        {houses.length > 1 ? (
          <label className="sm:col-span-2">
            <span className={MODAL_FIELD_LABEL_CLASS}>Home</span>
            <Select
              value={propertyId}
              disabled={busy}
              onChange={(event) => {
                setPropertyId(event.target.value);
                setCart([]);
                setCheckIn("");
                setCheckOut("");
              }}
            >
              {houses.map((house) => (
                <option key={house.id} value={house.id}>
                  {house.label}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label>
          <span className={MODAL_FIELD_LABEL_CLASS}>Room</span>
          <Select
            value={roomId}
            disabled={busy || !listing}
            onChange={(event) => {
              setRoomId(event.target.value);
              const next = listing?.rooms.find((candidate) => candidate.id === event.target.value);
              if (next) setGuests((current) => Math.min(current, next.sleeps));
              setCart([]);
            }}
          >
            {(listing?.rooms ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} · {formatShortStayMoney(candidate.nightly)}/night
              </option>
            ))}
          </Select>
        </label>
        <div>
          <span className={MODAL_FIELD_LABEL_CLASS}>Guests</span>
          <div className="flex items-center gap-3 py-1.5">
            <PortalIconAction icon={Minus} label="Fewer guests" disabled={busy || guests <= 1} onClick={() => setGuests((n) => Math.max(1, n - 1))} data-attr="book-again-guests-minus" />
            <span className="min-w-6 text-center text-[15px] font-semibold tabular-nums" data-attr="book-again-guests">{guests}</span>
            <PortalIconAction icon={Plus} label="More guests" disabled={busy || guests >= sleeps} onClick={() => setGuests((n) => Math.min(sleeps, n + 1))} data-attr="book-again-guests-plus" />
          </div>
        </div>

        <div className="sm:col-span-2">
          <span className={MODAL_FIELD_LABEL_CLASS}>When</span>
          <div className="flex flex-wrap gap-2" data-attr="book-again-quick-picks">
            {shortStayQuickPicks(today).map((pick) => (
              <Button key={pick.id} type="button" variant="outline" disabled={busy || !room || cart.length >= SHORT_STAY_MAX_RANGES} onClick={() => quickPick(pick)} data-attr={`book-again-quick-${pick.id}`}>
                {pick.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2" data-attr="book-again-calendar">
          <div className="mb-2 flex items-center justify-between">
            <PortalIconAction icon={ChevronLeft} label="Previous month" disabled={month <= monthStart(today)} onClick={() => setMonth((m) => shiftMonth(m, -1))} />
            <span className="text-[14px] font-semibold">{monthLabel(month)}</span>
            <PortalIconAction icon={ChevronRight} label="Next month" disabled={month >= monthStart(lastBookableDay)} onClick={() => setMonth((m) => shiftMonth(m, 1))} />
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[12px] text-muted">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {calendarDays.map((day, index) => {
              if (!day) return <span key={`blank-${index}`} />;
              const state = dayState(day);
              const inDraft = Boolean(checkIn && ((checkOut && day >= checkIn && day <= checkOut) || day === checkIn));
              const inCart = cart.some((range) => day >= range.checkIn && day < range.checkOut);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={state.disabled || busy || !room}
                  onClick={() => pickDay(day)}
                  data-day={day}
                  data-taken={state.taken ? "" : undefined}
                  aria-label={`${shortStayDayLabel(day)}${state.taken ? ", taken" : ""}`}
                  aria-pressed={inDraft || inCart}
                  className={[
                    "grid h-10 place-items-center rounded-lg text-[14px] tabular-nums transition-colors",
                    inDraft ? "bg-primary text-white" : inCart ? "bg-primary/15 text-foreground" : "hover:bg-accent",
                    state.taken ? "text-muted line-through" : "",
                    state.disabled && !state.taken ? "text-muted/50" : "",
                    "disabled:cursor-not-allowed",
                  ].join(" ")}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>
        </div>

        <label>
          <span className={MODAL_FIELD_LABEL_CLASS}>Check-in</span>
          <DateField value={checkIn} onChange={(value) => { setCheckIn(value); if (value) setMonth(monthStart(value)); }} />
        </label>
        <label>
          <span className={MODAL_FIELD_LABEL_CLASS}>Check-out</span>
          <DateField value={checkOut} onChange={setCheckOut} />
        </label>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <span className="min-w-0 text-[13px] text-danger" role={draftProblem ? "alert" : undefined}>{draftProblem}</span>
          <Button type="button" variant="outline" disabled={!draft || Boolean(draftProblem) || busy || cart.length >= SHORT_STAY_MAX_RANGES} onClick={() => draft && addToCart(draft)} data-attr="book-again-add-stay">
            Add this stay
          </Button>
        </div>

        {cart.length > 0 ? (
          <ul className="divide-y divide-border rounded-xl border border-border sm:col-span-2" data-attr="book-again-cart">
            {cart.map((range) => {
              const result = resultFor(range);
              const refused = result && (result.outcome === "unavailable" || result.outcome === "invalid");
              const nights = rangeDaysBetween(range.checkIn, range.checkOut);
              return (
                <li key={rangeKey(range)} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-[14px]" data-outcome={result?.outcome}>
                  <span className="min-w-0">
                    <span className="block">
                      {shortStayDayLabel(range.checkIn)} → {shortStayDayLabel(range.checkOut)} · {nights} {nights === 1 ? "night" : "nights"} · {formatShortStayMoney(shortStayTotal(room?.nightly ?? 0, nights))}
                    </span>
                    {refused ? <span className="block text-[13px] text-danger" role="alert">{result.error}</span> : null}
                  </span>
                  <PortalIconAction icon={X} label="Remove this stay" disabled={busy} onClick={() => setCart((current) => current.filter((item) => rangeKey(item) !== rangeKey(range)))} data-attr="book-again-remove-stay" />
                </li>
              );
            })}
          </ul>
        ) : null}

        {listingState === "error" ? <p role="alert" className="text-danger sm:col-span-2">This home doesn&apos;t take short stays right now.</p> : null}
        {dry.status === "error" ? <p role="alert" className="text-danger sm:col-span-2">{dry.message}</p> : null}
        {error ? <p role="alert" className="text-danger sm:col-span-2" data-attr="book-again-error">{error}</p> : null}
      </div>
    );

  return (
    <PortalDialog
      open
      onClose={onClose}
      title="Book again"
      dataAttr="book-again-sheet"
      step={{ current: phase === "result" ? 2 : 1, total: 2 }}
      contextPanel={
        <PopupSubjectCard
          title={listing?.propertyLabel ?? seed?.propertyLabel ?? "Book again"}
          lines={[room ? `${room.label} · ${formatShortStayMoney(room.nightly)} / night` : seed?.roomLabel]}
        />
      }
      previewLabel="Stay preview"
      preview={preview}
      primaryAction={{
        label: primaryLabel,
        onClick: phase === "result" ? onClose : submit,
        disabled: phase === "result" ? false : !canSubmit,
        loading: busy,
        dataAttr: "book-again-primary",
      }}
    >
      {content}
    </PortalDialog>
  );
}
