"use client";

/**
 * Resident portal › Request a stay (`/resident/stays/request?listing=&room=&checkIn=&checkOut=&guests=`):
 * the short-stay booking APPLICATION. It is built like the long-term application and the Add property
 * pop-up (`AddWorkspace`: a step rail, a live preview pane, Back and one primary at the foot): Stay
 * (room, dates, guests, arrival, early check-in / late checkout, the live total), Guests (the account
 * holder from the session, then a name for everyone else), About the stay (purpose, a note to the host,
 * the house-rules agreement) and Review. Submit is `POST /api/resident/stays` with the answers; identity is
 * the session, never a field here.
 *
 * It is always a REQUEST: the host answers within 24 hours, nothing is charged now, and an approval puts the
 * stay's charge in Payments. There is no Quick book and no instant confirm on this page. A signed-out visitor
 * never reaches it (the portal layout sends them to create a resident account first). See
 * docs/agents/bookings.md § Guest portal stays.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  PreviewPanel,
  ReviewCard,
  WIZARD_LABEL_CLASS,
  WizardField,
  WizardLockedField,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { StayRequestCalendar, monthStart } from "@/components/portal/stay-request-calendar";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { normalizePropertyStayTimes, stayAddOnLabel, type StayAddOnKind } from "@/lib/bookings/stay-times";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import { addRangeDays, pacificTodayKey, rangeDaysBetween } from "@/lib/room-availability-range";
import {
  fetchBookableListing,
  GUEST_STAYS_CHANGED,
  GuestStaysError,
  postGuestStays,
  type BookableListing,
} from "@/lib/short-stay/guest-stays-client";
import { SHORT_STAY_HOLD_HOURS, SHORT_STAY_PAY_HOURS, type GuestRangeResult } from "@/lib/short-stay/guest-stays";
import { STAY_MESSAGE_MAX, STAY_PURPOSES, stayPurposeLabel } from "@/lib/short-stay/stay-application";
import type { StayRequestPrefill } from "@/lib/short-stay/stay-request-link";
import {
  addOnsQuoteCents,
  estimatedArrivalOptions,
  offersForBooking,
  stayAddOnCheckLabel,
  standardTimesLine,
} from "@/lib/short-stay/stay-add-ons";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";
import {
  SHORT_STAY_MAX_DAYS_AHEAD,
  SHORT_STAY_MAX_NIGHTS,
  formatShortStayMoney,
  shortStayDayLabel,
  shortStayTotal,
} from "@/lib/short-stay-request";

type Dry = { status: "idle" | "checking" | "ready" | "error"; result: GuestRangeResult | null; message: string };

const STEPS = ["stay", "guests", "about", "review"] as const;
type StepId = (typeof STEPS)[number];

export function ResidentStayRequest({ basePath = "/resident", prefill }: { basePath?: string; prefill: StayRequestPrefill }) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const today = pacificTodayKey();
  const lastBookableDay = addRangeDays(today, SHORT_STAY_MAX_DAYS_AHEAD);
  const staysHref = `${basePath}/stays/upcoming`;

  const [listing, setListing] = useState<BookableListing | null>(null);
  const [listingState, setListingState] = useState<"loading" | "ready" | "missing">(prefill.listing ? "loading" : "missing");
  const [step, setStep] = useState(0);
  const [roomId, setRoomId] = useState(prefill.room);
  const [guests, setGuests] = useState(Math.max(1, prefill.guests));
  const [checkIn, setCheckIn] = useState(prefill.checkIn);
  const [checkOut, setCheckOut] = useState(prefill.checkOut > prefill.checkIn ? prefill.checkOut : "");
  const [month, setMonth] = useState(monthStart(prefill.checkIn || addRangeDays(today, 1)));
  // "none" = Not sure: nothing is stored. Any other value is the "HH:MM" the guest expects to arrive.
  const [arrival, setArrival] = useState("none");
  const [tickedAddOns, setTickedAddOns] = useState<StayAddOnKind[]>([]);
  const [otherNames, setOtherNames] = useState<string[]>([]);
  const [purpose, setPurpose] = useState("");
  const [message, setMessage] = useState("");
  const [rulesAgreed, setRulesAgreed] = useState(false);
  const [dry, setDry] = useState<Dry>({ status: "idle", result: null, message: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checkId = useRef(0);

  // The house: its bookable rooms, rules, standard times and the account holder's name.
  useEffect(() => {
    if (!prefill.listing) return;
    let cancelled = false;
    void fetchBookableListing(prefill.listing)
      .then((next) => {
        if (cancelled) return;
        setListing(next);
        setListingState(next ? "ready" : "missing");
        if (next) {
          const chosen = next.rooms.find((room) => room.id === prefill.room) ?? next.rooms[0];
          setRoomId(chosen?.id ?? "");
          if (chosen) setGuests((current) => Math.min(Math.max(1, current), chosen.sleeps));
        }
      })
      .catch(() => {
        if (!cancelled) setListingState("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [prefill.listing, prefill.room]);

  const room = listing?.rooms.find((candidate) => candidate.id === roomId) ?? null;
  const sleeps = room?.sleeps ?? 1;
  const propertyId = prefill.listing;
  const { rooms: occupancyRows } = useListingPublicOccupancy(propertyId || null);
  const spans = useMemo(() => findPublicRoomOccupancy(occupancyRows, propertyId, roomId)?.spans ?? [], [occupancyRows, propertyId, roomId]);
  const nightTaken = (night: string) => !shortStayRangeHasRoom(spans, sleeps, night, addRangeDays(night, 1));
  const rangeFree = (range: { checkIn: string; checkOut: string }) => {
    for (let night = range.checkIn; night < range.checkOut; night = addRangeDays(night, 1)) if (nightTaken(night)) return false;
    return true;
  };

  const nights = checkIn && checkOut && checkOut > checkIn ? rangeDaysBetween(checkIn, checkOut) : 0;
  const datesProblem = !nights
    ? ""
    : checkIn < today
      ? "Check-in can't be in the past."
      : checkIn > lastBookableDay
        ? `Check-in must be within ${SHORT_STAY_MAX_DAYS_AHEAD} days.`
        : nights > SHORT_STAY_MAX_NIGHTS
          ? `Stays are ${SHORT_STAY_MAX_NIGHTS} nights at most.`
          : !rangeFree({ checkIn, checkOut })
            ? "Some of those nights are taken."
            : "";
  const datesReady = nights > 0 && !datesProblem;

  // Keep one name field per other guest.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the name list follows the head-count
    setOtherNames((current) => Array.from({ length: Math.max(0, guests - 1) }, (_, i) => current[i] ?? ""));
  }, [guests]);

  // Ask the server whether these nights can be requested (and which add-ons they could carry); writes nothing.
  useEffect(() => {
    if (!propertyId || !roomId || !datesReady) {
      checkId.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- unusable dates clear the server's answer
      setDry({ status: "idle", result: null, message: "" });
      return;
    }
    const id = ++checkId.current;
    setDry((current) => ({ ...current, status: "checking" }));
    const timer = window.setTimeout(() => {
      void postGuestStays({ propertyId, roomId, ranges: [{ checkIn, checkOut }], guests, dryRun: true })
        .then((response) => {
          if (id === checkId.current) setDry({ status: "ready", result: response.results[0] ?? null, message: "" });
        })
        .catch((caught: unknown) => {
          if (id !== checkId.current) return;
          const refused = caught instanceof GuestStaysError ? caught.results?.[0] ?? null : null;
          setDry({ status: refused ? "ready" : "error", result: refused, message: caught instanceof Error ? caught.message : "Couldn't check those dates." });
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [propertyId, roomId, guests, checkIn, checkOut, datesReady]);

  const result = dry.result;
  const refused = result && (result.outcome === "unavailable" || result.outcome === "invalid");
  const offers = offersForBooking([result?.addOns]);
  const activeAddOns = tickedAddOns.filter((kind) => offers.some((offer) => offer.kind === kind));
  const addOnsCents = addOnsQuoteCents([result?.addOns], activeAddOns);
  const stayTimes = normalizePropertyStayTimes(listing?.stayTimes);
  const staySubtotal = room && nights ? shortStayTotal(room.nightly, nights) : 0;
  const total = staySubtotal + addOnsCents / 100;
  const stayOk = Boolean(room) && datesReady && dry.status === "ready" && !refused;
  const accountName = listing?.guestName?.trim() || "You";
  const namesOk = otherNames.every((name) => name.trim().length > 0);
  const aboutOk = Boolean(purpose) && rulesAgreed;
  const ready = stayOk && namesOk && aboutOk;

  const pickDay = (day: string) => {
    setError("");
    if (!checkIn || checkOut || day <= checkIn) {
      setCheckIn(day);
      setCheckOut("");
      return;
    }
    setCheckOut(day);
  };

  const steps: AddWorkspaceStep[] = [
    { id: "stay", label: "Stay", incomplete: !stayOk },
    { id: "guests", label: "Guests", incomplete: !namesOk },
    { id: "about", label: "About the stay", incomplete: !aboutOk },
    { id: "review", label: "Review" },
  ];
  const currentId: StepId = STEPS[Math.min(step, STEPS.length - 1)]!;

  const close = () => navigate(staysHref);

  const submit = async () => {
    if (busy || !ready || !room) return;
    setBusy(true);
    setError("");
    try {
      const response = await postGuestStays({
        propertyId,
        roomId,
        ranges: [{ checkIn, checkOut }],
        guests,
        ...(arrival !== "none" ? { estimatedArrival: arrival } : {}),
        ...(activeAddOns.length ? { addOns: activeAddOns } : {}),
        application: { purpose, message: message.trim(), guestNames: otherNames.map((name) => name.trim()), rulesAgreed },
      });
      window.dispatchEvent(new Event(GUEST_STAYS_CHANGED));
      // A host who ticked instant confirm for returning guests answers at once, and the nights are then
      // held on payment: say what actually happened rather than promising an answer that already came.
      if (response.results[0]?.outcome === "confirmed") {
        showToast(`Confirmed. Pay within ${SHORT_STAY_PAY_HOURS} hours.`, {
          actionLabel: "Payments",
          undo: () => navigate(`${basePath}/payments`),
        });
      } else {
        showToast(`Request sent. The host has ${SHORT_STAY_HOLD_HOURS} hours to answer.`);
      }
      navigate(staysHref, { replace: true });
    } catch (caught) {
      if (caught instanceof GuestStaysError && caught.status === 409) setError("Someone just booked those nights. Pick other dates.");
      else setError(caught instanceof Error ? caught.message : "Could not send your request.");
      if (caught instanceof GuestStaysError && caught.status === 409) setStep(0);
    } finally {
      setBusy(false);
    }
  };

  if (listingState === "loading") {
    return <div className="flex items-center justify-center px-6 py-16 text-sm text-muted" data-attr="stay-request-loading">Loading…</div>;
  }
  if (listingState === "missing" || !listing || !room) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center" data-attr="stay-request-missing">
        <p className="text-[15px] font-semibold text-foreground">This home doesn&apos;t take short stays right now.</p>
        <Button type="button" variant="outline" onClick={() => navigate("/rent/browse")} data-attr="stay-request-find-room">Find a room</Button>
      </div>
    );
  }

  const arrivalLabel = arrival === "none" ? "Not sure" : (estimatedArrivalOptions().find((option) => option.value === arrival)?.label ?? arrival);
  const preview = (
    <PreviewPanel
      title="Your request"
      name={listing.propertyLabel}
      sub={`${room.label} · ${formatShortStayMoney(room.nightly)} / night`}
      facts={[
        { label: "Check-in", value: checkIn ? shortStayDayLabel(checkIn) : "Not set", warn: !checkIn },
        { label: "Check-out", value: checkOut ? shortStayDayLabel(checkOut) : "Not set", warn: !checkOut },
        { label: "Nights", value: nights ? String(nights) : "0" },
        { label: "Guests", value: String(guests) },
        ...(addOnsCents ? [{ label: "Add-ons", value: formatShortStayMoney(addOnsCents / 100) }] : []),
        { label: "Total", value: formatShortStayMoney(total) },
      ]}
    />
  );

  return (
    <AddWorkspace
      title="Request a stay"
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={close}
      numberedSteps
      assistantContext="Helping a resident request a short stay."
      assistantScopeKey="resident-stay-request"
      lastLabel="Request to book"
      lastDisabled={!ready}
      nextDisabled={(currentId === "stay" && !stayOk) || (currentId === "guests" && !namesOk) || (currentId === "about" && !aboutOk)}
      busy={busy}
      onFinish={() => void submit()}
      saveState={busy ? "Sending" : "Not sent yet"}
      sidePanel={preview}
      dataAttrPrefix="stay-request"
    >
      {currentId === "stay" ? (
        <>
          <WizardSection title="Room" dataAttr="stay-request-room">
            <p className="mb-3 text-[15px] font-semibold text-foreground">{listing.propertyLabel}</p>
            <WizardSelect
              label="Room *"
              value={roomId}
              disabled={busy}
              options={listing.rooms.map((candidate) => ({ value: candidate.id, label: `${candidate.label} · ${formatShortStayMoney(candidate.nightly)}/night` }))}
              onChange={(next) => {
                setRoomId(next);
                const picked = listing.rooms.find((candidate) => candidate.id === next);
                if (picked) setGuests((current) => Math.min(current, picked.sleeps));
              }}
              dataAttr="stay-request-room-select"
            />
            <div className="mt-4">
              <span className={WIZARD_LABEL_CLASS}>Guests</span>
              <div className="flex items-center gap-3 py-1.5">
                <PortalIconAction icon={Minus} label="Fewer guests" disabled={busy || guests <= 1} onClick={() => setGuests((n) => Math.max(1, n - 1))} data-attr="stay-request-guests-minus" />
                <span className="min-w-6 text-center text-[15px] font-semibold tabular-nums" data-attr="stay-request-guests">{guests}</span>
                <PortalIconAction icon={Plus} label="More guests" disabled={busy || guests >= sleeps} onClick={() => setGuests((n) => Math.min(sleeps, n + 1))} data-attr="stay-request-guests-plus" />
              </div>
            </div>
          </WizardSection>
          <WizardSection title="Dates" dataAttr="stay-request-dates">
            <StayRequestCalendar
              month={month}
              onMonth={setMonth}
              today={today}
              lastBookableDay={lastBookableDay}
              checkIn={checkIn}
              checkOut={checkOut}
              nightTaken={nightTaken}
              rangeFree={rangeFree}
              onPickDay={pickDay}
              disabled={busy}
            />
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <WizardField label="Check-in" required>
                <DateField value={checkIn} onChange={(value) => { setCheckIn(value); if (value) setMonth(monthStart(value)); if (checkOut && value >= checkOut) setCheckOut(""); }} />
              </WizardField>
              <WizardField label="Check-out" required>
                <DateField value={checkOut} onChange={setCheckOut} />
              </WizardField>
            </div>
            {datesProblem || (refused && result?.error) || dry.status === "error" ? (
              <p role="alert" className="mt-3 text-[13px] text-danger" data-attr="stay-request-dates-problem">
                {datesProblem || (refused ? result?.error : dry.message)}
              </p>
            ) : null}
          </WizardSection>
          <WizardSection title="Arrival" dataAttr="stay-request-arrival">
            <p className="mb-3 text-[14px] font-medium text-foreground" data-attr="stay-request-standard-times">{standardTimesLine(stayTimes)}</p>
            <FieldSingleSelect
              label="Estimated arrival"
              value={arrival}
              disabled={busy}
              options={[{ value: "none", label: "Not sure" }, ...estimatedArrivalOptions().filter((option) => option.value !== "")]}
              onChange={setArrival}
              dataAttr="stay-request-arrival-select"
            />
            {offers.length > 0 ? (
              <div className="mt-3 space-y-1" data-attr="stay-request-add-ons">
                {offers.map((offer) => {
                  const label = stayAddOnCheckLabel(offer);
                  if (!label) return null;
                  return (
                    <label key={offer.kind} className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] sm:text-[14px]" data-attr={`stay-request-add-on-${offer.kind}`}>
                      <input
                        type="checkbox"
                        className="size-5 shrink-0 rounded border-border"
                        checked={activeAddOns.includes(offer.kind)}
                        disabled={busy}
                        onChange={(event) => setTickedAddOns((current) => (event.target.checked ? [...new Set([...current, offer.kind])] : current.filter((kind) => kind !== offer.kind)))}
                        aria-label={stayAddOnLabel(offer.kind)}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </WizardSection>
        </>
      ) : null}

      {currentId === "guests" ? (
        <WizardSection title="Who's staying" dataAttr="stay-request-guests-section">
          <div className="space-y-3">
            <WizardLockedField label="Guest 1" value={accountName} lockTip="Your account" />
            {otherNames.map((name, index) => (
              <WizardField key={index} label={`Guest ${index + 2}`} required>
                <Input
                  value={name}
                  maxLength={120}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setOtherNames((current) => current.map((existing, i) => (i === index ? event.target.value : existing)))}
                  data-attr={`stay-request-guest-name-${index + 2}`}
                />
              </WizardField>
            ))}
          </div>
        </WizardSection>
      ) : null}

      {currentId === "about" ? (
        <>
          <WizardSection title="About the stay" dataAttr="stay-request-about">
            <div className="space-y-4">
              <WizardSelect
                label="What is the stay for? *"
                value={purpose}
                disabled={busy}
                options={STAY_PURPOSES.map((candidate) => ({ value: candidate.value, label: candidate.label }))}
                onChange={setPurpose}
                dataAttr="stay-request-purpose"
              />
              <WizardField label="Message to the host">
                <Textarea
                  rows={4}
                  value={message}
                  maxLength={STAY_MESSAGE_MAX}
                  disabled={busy}
                  onChange={(event) => setMessage(event.target.value)}
                  data-attr="stay-request-message"
                />
              </WizardField>
            </div>
          </WizardSection>
          <WizardSection title="House rules" dataAttr="stay-request-rules">
            {listing.houseRules || listing.shortStayRequirements ? (
              <div className="mb-3 max-h-40 space-y-2 overflow-y-auto whitespace-pre-line rounded-lg border border-border bg-accent/30 p-3 text-[14px] text-foreground" data-attr="stay-request-rules-text">
                {[listing.shortStayRequirements, listing.houseRules].filter(Boolean).join("\n\n")}
              </div>
            ) : null}
            <div data-wizard-field="stay-request-rules-agree" data-wizard-label="House rules" data-wizard-required="true" data-wizard-empty={!rulesAgreed}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] sm:text-[14px]">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 rounded border-border"
                  checked={rulesAgreed}
                  disabled={busy}
                  onChange={(event) => setRulesAgreed(event.target.checked)}
                  data-attr="stay-request-rules-agree"
                />
                <span>I agree to the house rules</span>
              </label>
            </div>
          </WizardSection>
        </>
      ) : null}

      {currentId === "review" ? (
        <div data-attr="stay-request-review">
          <ReviewCard
            title="Stay"
            status={stayOk ? "complete" : "incomplete"}
            onEdit={() => setStep(0)}
            facts={[
              { label: "Home", value: listing.propertyLabel },
              { label: "Room", value: room.label },
              { label: "Check-in", value: checkIn ? shortStayDayLabel(checkIn) : "Not set", missing: !checkIn },
              { label: "Check-out", value: checkOut ? shortStayDayLabel(checkOut) : "Not set", missing: !checkOut },
              { label: "Nights", value: String(nights) },
              { label: "Arrival", value: arrivalLabel },
              ...(activeAddOns.length ? [{ label: "Add-ons", value: activeAddOns.map(stayAddOnLabel).join(", ") }] : []),
              { label: "Total", value: formatShortStayMoney(total) },
            ]}
          />
          <ReviewCard
            title="Guests"
            status={namesOk ? "complete" : "incomplete"}
            onEdit={() => setStep(1)}
            facts={[{ label: "Guest 1", value: accountName }, ...otherNames.map((name, index) => ({ label: `Guest ${index + 2}`, value: name.trim() || "Not set", missing: !name.trim() }))]}
          />
          <ReviewCard
            title="About the stay"
            status={aboutOk ? "complete" : "incomplete"}
            onEdit={() => setStep(2)}
            facts={[
              { label: "Purpose", value: purpose ? stayPurposeLabel(purpose) : "Not set", missing: !purpose },
              { label: "Message", value: message.trim() || "None" },
              { label: "House rules", value: rulesAgreed ? "Agreed" : "Not agreed", missing: !rulesAgreed },
            ]}
          />
          {error ? <p role="alert" className="mt-2 text-sm font-semibold text-danger" data-attr="stay-request-error">{error}</p> : null}
        </div>
      ) : null}
    </AddWorkspace>
  );
}

