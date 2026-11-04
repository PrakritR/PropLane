"use client";

import { composePropertyTitle } from "@/lib/property-title";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { ResidentAppleSignUpButton } from "@/components/auth/resident-apple-sign-up-button";
import { ResidentGoogleSignUpButton } from "@/components/auth/resident-google-sign-up-button";
import { AuthDivider } from "@/components/auth/auth-mobile-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { MockProperty } from "@/data/types";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { roomMonthlyEquivalentLabel } from "@/lib/room-pricing";
import {
  appendPartnerInquiryToServer,
  dateHasAvailability,
  dateSlotKey,
  formatAvailabilitySlotLabel,
  localDateAtSlotStart,
  type PropertyManagerEntry,
  toLocalDateStr,
} from "@/lib/demo-admin-scheduling";
import {
  ProspectAccountHandoff,
  ProspectPublicSuccessBanner,
  ProspectViewInPortalAction,
  PUBLIC_PROSPECT_CANVAS_CLASS,
} from "@/components/marketing/prospect-public-handoff";
import { useProspectContactAutofill, type ProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { linkBookedToursToSignedInResident } from "@/lib/tour-resident-link.client";
import { residentCreateAccountHref, residentSignInHref } from "@/lib/resident-public-nav";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";
import { canNavigateToWizardStep, nextWizardMaxReached } from "@/lib/wizard-step-nav";
import { DEFAULT_TOUR_FORMAT, TOUR_FORMAT_OPTIONS, type TourFormat } from "@/lib/tour-format";
import {
  TOUR_STEP_FIELD_ORDER,
  scrollToFirstWizardFieldError,
  wizardFieldErrorClass,
  wizardSectionErrorClass,
} from "@/lib/wizard-field-errors";
import {
  formatTourContactPhoneDisplay,
  normalizeTourContactPhone,
  validateTourContactFields,
} from "@/lib/tour-contact-quality";
import {
  getRoomUnavailabilityWindows,
  isRoomChoiceAvailable,
} from "@/lib/rental-application/data";
import { syncPublicApprovedApplicationsFromServer } from "@/lib/manager-applications-storage";
import { TourApplicationFirstPanel } from "@/components/marketing/tour-application-first-panel";
import { useTourApplicationGate } from "@/hooks/use-tour-application-gate";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import {
  REQUESTED_TOUR_KIND,
  formatRequestedTourTime,
  requestedTourCaption,
  requestedTourDates,
  requestedTourSlotIndices,
} from "@/lib/tour-request-time";
import { isoWindowFromSlotKey } from "@/lib/tour-slot-math";
import {
  parseTourSlotKey,
  tourRoomParamForKey,
  tourSchedulePath,
} from "@/lib/tour-schedule-link";

/** 1 = Date & time (room rides along as a dropdown that defaults to "any"), 2 = Your details. */
type TourStep = 1 | 2;

/** Banner when a prospect picks a room that is fully booked (PRP-398 tour half). */
export function tourRoomAvailabilityMessage(roomKey: string | null | undefined): string | null {
  if (!roomKey || isTourRoomUndecided(roomKey)) return null;
  if (isRoomChoiceAvailable(roomKey, "")) return null;
  const windows = getRoomUnavailabilityWindows(roomKey);
  const detail = windows[0]?.label?.trim();
  if (detail) {
    return `This room is not available for your dates (${detail}). You can still schedule a tour, or choose another room.`;
  }
  return "This room is not available for your selected dates. You can still schedule a tour, or choose another room.";
}


function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

/** Bookable tour days/slots — primary blue, aligned with PropLane accent. */
const TOUR_OPEN_DAY_CLASS =
  "bg-primary/12 text-primary ring-1 ring-inset ring-primary/25 hover:bg-primary/20";
const TOUR_OPEN_SLOT_CLASS =
  "border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/15";

type TourRoomOption = {
  key: string;
  label: string;
  subtitle: string;
  property: MockProperty;
};

/**
 * Why a FAILED availability read can never be rendered as an empty grid.
 *
 * "No tour times yet" is a confident claim
 * about the property, and a prospect who reads it leaves. A throttled read (the
 * public route is IP rate-limited, so a shared NAT can trip it) or a 500 says
 * nothing at all about the property, and collapsing both into `{}` tells that
 * prospect a lie about a house with a full calendar. Same invariant the
 * resident tour panel holds: a failed read is a failed read, with a retry.
 */
export function tourAvailabilityReadErrorMessage(status: number): string {
  if (status === 429) {
    return "We're loading a lot of tour calendars right now. Wait a moment and try again — this property may well have open windows.";
  }
  return "We couldn't load this property's tour windows just now. Check your connection and try again.";
}

export { linkBookedToursToSignedInResident } from "@/lib/tour-resident-link.client";

/** Sentinel when the prospect wants a property tour but has not picked a room yet. */
export const TOUR_ROOM_UNDECIDED_KEY = "__tour-room-undecided__";
export const TOUR_ROOM_UNDECIDED_LABEL = "Not sure which room yet";

export function isTourRoomUndecided(roomKey: string | null | undefined): boolean {
  return roomKey === TOUR_ROOM_UNDECIDED_KEY;
}

function tourRoomLabelForKey(property: MockProperty, roomKey: string | null): string {
  if (!roomKey) return "";
  if (isTourRoomUndecided(roomKey)) return TOUR_ROOM_UNDECIDED_LABEL;
  const hit = roomOptionsForProperty(property).find((o) => o.key === roomKey);
  return hit?.label ?? property.title;
}

function roomOptionsForProperty(p: MockProperty): TourRoomOption[] {
  if (p.listingSubmission?.v === 1) {
    const sub = normalizeManagerListingSubmissionV1(p.listingSubmission);
    const rooms = sub.rooms.filter((r) => r.name.trim());
    if (rooms.length > 0) {
      return rooms.map((room) => {
        const parts = [room.name.trim(), room.floor.trim(), roomMonthlyEquivalentLabel(room)].filter(Boolean);
        return {
          key: `${p.id}::${room.id}`,
          label: parts.join(" · "),
          subtitle: p.title,
          property: p,
        };
      });
    }
  }
  return [
    {
      key: p.id,
      label: composePropertyTitle(p.buildingName, p.unitLabel),
      subtitle: `${p.neighborhood} · ${p.rentLabel}`,
      property: p,
    },
  ];
}

/**
 * The room a tour starts with. A prospect never has to pick one: several rooms default to "not sure yet",
 * one room is that room. `room` is the URL param (`<roomId>` or `any`) when a pick travelled through sign-in.
 */
export function defaultTourRoomKey(property: MockProperty, room?: string | null): string {
  const rooms = roomOptionsForProperty(property);
  const wanted = room?.trim();
  if (wanted && wanted !== "any") {
    const hit = rooms.find((option) => option.key === `${property.id}::${wanted}`);
    if (hit) return hit.key;
  }
  return rooms.length > 1 ? TOUR_ROOM_UNDECIDED_KEY : (rooms[0]?.key ?? property.id);
}

/**
 * True when at least one published tour slot is today or later. A grid whose every published slot is already
 * past looks exactly like one with none: every day disabled, nothing to pick. Both read as "No tour times yet".
 * Slot keys are `YYYY-MM-DD:slotIndex`, so a string comparison on the date part orders them.
 */
export function tourAvailabilityHasUpcoming(availability: ReadonlySet<string>, todayDateStr: string): boolean {
  for (const key of availability) {
    const date = key.split(":")[0] ?? "";
    if (date >= todayDateStr) return true;
  }
  return false;
}

function openSlotIndicesForDateStr(availability: Set<string>, dateStr: string): number[] {
  const out: number[] = [];
  for (const key of availability) {
    const [keyDate, slotText] = key.split(":");
    if (keyDate !== dateStr) continue;
    const slotIndex = Number.parseInt(slotText ?? "", 10);
    if (Number.isFinite(slotIndex)) out.push(slotIndex);
  }
  return out.sort((a, b) => a - b);
}
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Tuesday, October 21" for a calendar day the picker holds as year / month index / day. */
function tourDayLabel(year: number, month: number, day: number): string {
  const weekday = WEEKDAYS_LONG[new Date(year, month, day, 12, 0, 0, 0).getDay()] ?? "";
  return `${weekday}, ${MONTHS[month]} ${day}`;
}

/** Dates (YYYY-MM-DD, soonest first) that have at least one open slot today or later, capped for the day row. */
function upcomingOpenDates(availability: ReadonlySet<string>, todayDateStr: string, cap = 28): string[] {
  const dates = new Set<string>();
  for (const key of availability) {
    const date = key.split(":")[0] ?? "";
    if (date >= todayDateStr) dates.add(date);
  }
  return [...dates].sort().slice(0, cap);
}

function TourStepNavigationFooter({
  step,
  onBack,
  onContinue,
  pub = false,
}: {
  step: TourStep;
  onBack: () => void;
  onContinue: () => void;
  pub?: boolean;
}) {
  if (step >= 2) return null;
  if (pub) {
    return (
      <div className={`ps-j-nav ${step > 1 ? "" : "ps-j-nav-end"}`}>
        {step > 1 ? (
          <button type="button" className="ps-btn ps-btn-line" onClick={onBack}>
            Back
          </button>
        ) : null}
        <button type="button" className="ps-btn ps-btn-blue" onClick={onContinue}>
          Continue
        </button>
      </div>
    );
  }
  return (
    <div className={`flex w-full ${step > 1 ? "justify-between" : "justify-end"}`}>
      {step > 1 ? (
        <Button
          type="button"
          variant="outline"
          className="h-9 min-h-0 rounded-full px-4 text-[13px]"
          onClick={onBack}
        >
          Back
        </Button>
      ) : null}
      <Button
        type="button"
        variant="primary"
        className="h-9 min-h-0 rounded-full px-6 text-[13px]"
        onClick={onContinue}
      >
        Continue
      </Button>
    </div>
  );
}

export function TourScheduleFlow({
  property,
  returnAfterAuth,
  onSuccess,
  embedded = false,
  embeddedModalLayout = false,
  onEmbeddedFooterChange,
  onSuccessDismiss,
  onMessageHost,
  initialSlotKey,
  initialRoom,
}: {
  property: MockProperty;
  returnAfterAuth: string;
  /** A pick that travelled through sign-in (`slot` on /resident/tour/schedule): preselected, opens on Your details. */
  initialSlotKey?: string | null;
  /** `<roomId>` or `any`, the `room` that travelled with {@link initialSlotKey}. */
  initialRoom?: string | null;
  onSuccess: () => void;
  embedded?: boolean;
  /** Resident portal modal: pin Back/Continue below the assistant strip via {@link onEmbeddedFooterChange}. */
  embeddedModalLayout?: boolean;
  onEmbeddedFooterChange?: (footer: ReactNode | null) => void;
  /** When set, success screen offers Done that closes the host (e.g. resident modal). */
  onSuccessDismiss?: () => void;
  /** Embedded in the resident portal: the success screen's main button opens the host-team thread for the booked tour. */
  onMessageHost?: (inquiryId: string) => void;
}) {
  const { showToast } = useAppUi();
  // The public tour page (not the resident portal's embedded flow) wears the journey look.
  const pub = !embedded;
  const [initialSlot] = useState(() => parseTourSlotKey(initialSlotKey));
  const [step, setStep] = useState<TourStep>(initialSlot ? 2 : 1);
  const [maxStepReached, setMaxStepReached] = useState<TourStep>(initialSlot ? 2 : 1);
  const [submitted, setSubmitted] = useState(false);
  const [submittedContact, setSubmittedContact] = useState<{
    name: string;
    email: string;
    phone: string;
    inquiryId: string;
  } | null>(null);
  const contactAutofill = useProspectContactAutofill();
  const signedInUserId = contactAutofill.userId;
  const applicationGate = useTourApplicationGate(property, { signedIn: Boolean(signedInUserId) });
  const hasResidentRole = contactAutofill.hasResidentRole;
  const [tick, setTick] = useState(0);
  const [pickedRoomKey, setPickedRoomKey] = useState<string | null>(null);
  // Never forced: until the prospect touches the dropdown the room is the default ("not sure yet" for several).
  const selectedRoomKey = pickedRoomKey ?? defaultTourRoomKey(property, initialRoom);
  const setSelectedRoomKey = setPickedRoomKey;
  const selectedRoomLabel = useMemo(
    () => tourRoomLabelForKey(property, selectedRoomKey),
    [property, selectedRoomKey],
  );

  const [selectedDay, setSelectedDay] = useState<number | null>(initialSlot?.day ?? null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(initialSlot?.slotIndex ?? null);
  const [calMonth, setCalMonth] = useState(initialSlot?.month ?? new Date().getMonth());
  const [calYear, setCalYear] = useState(initialSlot?.year ?? new Date().getFullYear());
  // A refusal stays on the step that asked, with the chosen time still picked.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [slotHosts, setSlotHosts] = useState<Record<string, PropertyManagerEntry[]>>({});
  // Starts true: an availability fetch always runs on mount, and it is deferred
  // behind a microtask. Starting false made the first paint claim "No tour
  // windows are published" before the request had even been sent.
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [bookingTour, setBookingTour] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [detailsFooter, setDetailsFooter] = useState<ReactNode | null>(null);
  const [occupancySyncEpoch, setOccupancySyncEpoch] = useState(0);

  useEffect(() => {
    void syncPublicApprovedApplicationsFromServer().then(() =>
      setOccupancySyncEpoch((n) => n + 1),
    );
  }, [property.id]);

  useEffect(() => {
    const sync = () => setTick((n) => n + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, sync);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, sync);
    };
  }, []);

  const loadAvailability = useCallback(
    async (stillWanted: () => boolean = () => true) => {
      const params = new URLSearchParams({
        propertyId: property.id,
        buildingName: property.buildingName,
        address: property.address,
      });
      setAvailabilityLoading(true);
      try {
        const res = await fetch(`/api/public/property-tour-availability?${params.toString()}`);
        const body = (await res.json().catch(() => ({}))) as {
          slotHosts?: Record<string, PropertyManagerEntry[]>;
        };
        if (!stillWanted()) return;
        if (!res.ok) {
          setSlotHosts({});
          setAvailabilityError(tourAvailabilityReadErrorMessage(res.status));
          return;
        }
        setSlotHosts(body.slotHosts ?? {});
        setAvailabilityError(null);
      } catch {
        if (!stillWanted()) return;
        setSlotHosts({});
        setAvailabilityError(tourAvailabilityReadErrorMessage(0));
      } finally {
        if (stillWanted()) setAvailabilityLoading(false);
      }
    },
    [property],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      void loadAvailability(() => !cancelled);
    });
    return () => {
      cancelled = true;
    };
  }, [loadAvailability]);

  const selectedAvailability = useMemo(() => {
    void tick;
    return new Set(Object.entries(slotHosts).filter(([, hosts]) => hosts.length > 0).map(([slot]) => slot));
  }, [slotHosts, tick]);

  // No open slot at all: instead of a dead calendar the visitor picks any day from tomorrow and a 30-minute time,
  // and the manager confirms it (or suggests another). Never while loading or after a failed read, and never
  // when slots exist: then only those slots are offered, exactly as before.
  const requestMode =
    !availabilityLoading &&
    !availabilityError &&
    !tourAvailabilityHasUpcoming(selectedAvailability, pacificCalendarDateYmd());

  const slotManagerMap = useMemo(() => {
    const map = new Map<string, PropertyManagerEntry[]>();
    for (const [slot, hosts] of Object.entries(slotHosts)) {
      map.set(slot, hosts);
    }
    return map;
  }, [slotHosts]);

  const managersAtSelectedSlot = useMemo(() => {
    if (selectedDay == null || selectedSlotIndex == null) return [];
    const dateStr = toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0));
    return slotManagerMap.get(`${dateStr}:${selectedSlotIndex}`) ?? [];
  }, [selectedDay, selectedSlotIndex, calYear, calMonth, slotManagerMap]);

  const steps = [
    { n: 1, label: "Date & time" },
    { n: 2, label: "Your details" },
  ];

  const selectedSlotKey = useMemo(() => {
    if (selectedDay == null || selectedSlotIndex == null) return null;
    return dateSlotKey(toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0)), selectedSlotIndex);
  }, [selectedDay, selectedSlotIndex, calYear, calMonth]);

  // The picked time was open when it was chosen and is not any more (someone else took it, or the
  // calendar changed). Only ever true after a successful availability read.
  const slotGone =
    Boolean(selectedSlotKey) &&
    !requestMode &&
    !availabilityLoading &&
    !availabilityError &&
    !selectedAvailability.has(selectedSlotKey ?? "");

  const nextOpenTimes = useMemo(() => {
    if (!slotGone) return [];
    const today = pacificCalendarDateYmd();
    return [...selectedAvailability]
      .filter((key) => (key.split(":")[0] ?? "") >= today && key !== selectedSlotKey)
      .sort((a, b) => {
        const [dateA = "", slotA = "0"] = a.split(":");
        const [dateB = "", slotB = "0"] = b.split(":");
        return dateA === dateB ? Number(slotA) - Number(slotB) : dateA < dateB ? -1 : 1;
      })
      .slice(0, 4)
      .map((key) => parseTourSlotKey(key))
      .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);
  }, [slotGone, selectedAvailability, selectedSlotKey]);

  const accountNext = tourSchedulePath({
    propertyId: property.id,
    slotKey: selectedSlotKey,
    roomParam: tourRoomParamForKey(property.id, selectedRoomKey),
  });

  const goToPreviousStep = useCallback(() => {
    setStep((current) => (current - 1) as TourStep);
  }, []);

  const goToNextStep = useCallback(() => {
    const errs: Record<string, string> = {};
    if (step === 1) {
      if (selectedDay === null || selectedSlotIndex === null || (!requestMode && managersAtSelectedSlot.length === 0)) {
        errs.tourSlot = "Select a date and time for your tour.";
      }
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      showToast("Please fix the highlighted fields before continuing.");
      queueMicrotask(() => scrollToFirstWizardFieldError(TOUR_STEP_FIELD_ORDER[2] ?? [], errs));
      return;
    }
    setFieldErrors({});
    const next = (step + 1) as TourStep;
    setStep(next);
    setMaxStepReached((m) => nextWizardMaxReached(m, next) as TourStep);
  }, [managersAtSelectedSlot.length, requestMode, selectedDay, selectedSlotIndex, showToast, step]);

  useEffect(() => {
    if (!embeddedModalLayout || !onEmbeddedFooterChange) return;
    if (submitted) {
      onEmbeddedFooterChange(null);
      return;
    }
    if (step === 2) {
      onEmbeddedFooterChange(detailsFooter);
      return () => onEmbeddedFooterChange(null);
    }
    if (step < 2) {
      onEmbeddedFooterChange(
        <TourStepNavigationFooter step={step} onBack={goToPreviousStep} onContinue={goToNextStep} />,
      );
      return () => onEmbeddedFooterChange(null);
    }
    onEmbeddedFooterChange(null);
    return () => onEmbeddedFooterChange(null);
  }, [
    embeddedModalLayout,
    goToNextStep,
    goToPreviousStep,
    onEmbeddedFooterChange,
    step,
    detailsFooter,
    submitted,
  ]);

  if (applicationGate.status === "checking") {
    return <div className="px-2 py-6 text-sm text-muted">Checking this home…</div>;
  }
  if (
    applicationGate.status === "apply_first" ||
    applicationGate.status === "pending_approval" ||
    applicationGate.status === "denied"
  ) {
    return (
      <div className={embedded ? "space-y-6" : pub ? "ps-j-stack" : PUBLIC_PROSPECT_CANVAS_CLASS}>
        <TourApplicationFirstPanel propertyId={property.id} propertyTitle={property.title} reason={applicationGate.status} />
      </div>
    );
  }

  if (submitted) {
    const createAccountHref = submittedContact?.email
      ? residentCreateAccountHref(returnAfterAuth, {
          email: submittedContact.email,
          fullName: submittedContact.name,
          phone: submittedContact.phone,
          tourInquiryId: submittedContact.inquiryId,
        })
      : residentCreateAccountHref(returnAfterAuth);
    const signInHref = residentSignInHref(returnAfterAuth, {
      tourInquiryId: submittedContact?.inquiryId,
      email: submittedContact?.email,
      fullName: submittedContact?.name,
      phone: submittedContact?.phone,
    });

    if (pub) {
      const area = property.neighborhood?.trim() || property.address?.trim() || "";
      return (
        <div className="ps-j-stack" data-attr="tour-success">
          <ProspectPublicSuccessBanner ps eyebrow="Tour request sent" title="Your tour request is in">
            <ul className="ps-facts">
              <li>
                <span>Home</span>
                <span>{property.title}</span>
              </li>
              {selectedDay && selectedSlotIndex != null ? (
                <>
                  <li>
                    <span>Day</span>
                    <span>{tourDayLabel(calYear, calMonth, selectedDay)}</span>
                  </li>
                  <li>
                    <span>Time</span>
                    <span>{formatAvailabilitySlotLabel(selectedSlotIndex)}</span>
                  </li>
                </>
              ) : null}
              {selectedRoomLabel ? (
                <li>
                  <span>Room</span>
                  <span>{selectedRoomLabel}</span>
                </li>
              ) : null}
              {area ? (
                <li>
                  <span>Area</span>
                  <span>{area}</span>
                </li>
              ) : null}
            </ul>
            {/*
              A requested time reads like a booked one, so this says the opposite plainly. A guest
              who travels to the property on an unconfirmed request finds nobody there — the same
              warning is in the acknowledgment email.
            */}
            <p style={{ margin: 0, fontWeight: 600 }} data-attr="tour-request-not-confirmed-notice">
              This tour is not confirmed yet — please do not go to the property until you receive
              your confirmation.
            </p>
          </ProspectPublicSuccessBanner>

          <div className="ps-j-actions">
            {onSuccessDismiss ? (
              <button type="button" onClick={onSuccessDismiss} data-attr="tour-success-done" className="ps-btn ps-btn-blue">
                Done
              </button>
            ) : null}
            <Link
              href={buildRentalApplyHref({ propertyId: property.id })}
              data-attr="tour-success-apply"
              className="ps-btn ps-btn-blue"
            >
              Apply for this property
            </Link>
            <button
              type="button"
              onClick={() => {
                setSubmitted(false);
                setSubmittedContact(null);
                setStep(1);
                setMaxStepReached(1);
                setSelectedRoomKey(null);
                setSelectedDay(null);
                setSelectedSlotIndex(null);
              }}
              className="ps-btn ps-btn-line"
            >
              Request another tour
            </button>
            <Link href="/rent/browse" data-attr="tour-success-find-home" className="ps-btn ps-btn-line">
              Find another home
            </Link>
          </div>

          {!signedInUserId ? (
            <ProspectAccountHandoff
              ps
              title="Create an account to see your tour in PropLane"
              description="Track tour updates, read manager messages in Communication, and apply when you are ready."
              createAccountHref={createAccountHref}
              signInHref={signInHref}
              createAccountDataAttr="tour-success-create-account"
              signInDataAttr="tour-success-sign-in"
            />
          ) : (
            <ProspectViewInPortalAction
              ps
              signedIn
              hasResidentRole={hasResidentRole}
              portalPath={
                submittedContact?.inquiryId
                  ? `/resident/tour?link_tour=${encodeURIComponent(submittedContact.inquiryId)}`
                  : "/resident/tour/pending"
              }
              dataAttr="tour-success-view-in-portal"
            />
          )}
        </div>
      );
    }

    return (
      <div className={embedded ? "space-y-6" : PUBLIC_PROSPECT_CANVAS_CLASS}>
        <ProspectPublicSuccessBanner eyebrow="Tour request sent" title="Your tour request is in">
          <p>
            Your tour request was sent to the property manager. If you provided an email, you should receive a short
            acknowledgment shortly. You will get a separate confirmation once the manager approves your requested time.
          </p>
          <p className="font-medium">
            Requested tour: {property.title}
            {selectedDay && selectedSlotIndex != null
              ? ` · ${MONTHS[calMonth]} ${selectedDay}, ${calYear} · ${formatAvailabilitySlotLabel(selectedSlotIndex)}`
              : ""}
          </p>
          {/*
            A requested time reads like a booked one, so this says the opposite plainly. A guest
            who travels to the property on an unconfirmed request finds nobody there — the same
            warning is in the acknowledgment email.
          */}
          <p className="font-semibold" data-attr="tour-request-not-confirmed-notice">
            This tour is not confirmed yet — please do not go to the property until you receive
            your confirmation.
          </p>
        </ProspectPublicSuccessBanner>

        {!signedInUserId ? (
          <ProspectAccountHandoff
            title="Create an account to see your tour in PropLane"
            description="Track tour updates, read manager messages in Communication, and apply when you are ready."
            createAccountHref={createAccountHref}
            signInHref={signInHref}
            createAccountDataAttr="tour-success-create-account"
            signInDataAttr="tour-success-sign-in"
          />
        ) : (
          <ProspectViewInPortalAction
            signedIn
            hasResidentRole={hasResidentRole}
            portalPath={
              submittedContact?.inquiryId
                ? `/resident/tour?link_tour=${encodeURIComponent(submittedContact.inquiryId)}`
                : "/resident/tour/pending"
            }
            dataAttr="tour-success-view-in-portal"
          />
        )}

        <div className="flex flex-wrap gap-2">
          {onMessageHost && submittedContact?.inquiryId ? (
            <button
              type="button"
              onClick={() => onMessageHost(submittedContact.inquiryId)}
              data-attr="tour-success-message-host"
              className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Message the host
            </button>
          ) : null}
          {onSuccessDismiss ? (
            <button
              type="button"
              onClick={onSuccessDismiss}
              data-attr="tour-success-done"
              className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setSubmitted(false);
              setSubmittedContact(null);
              setStep(1);
              setMaxStepReached(1);
              setSelectedRoomKey(null);
              setSelectedDay(null);
              setSelectedSlotIndex(null);
            }}
            className="rounded-full border border-border px-5 py-2 text-sm font-semibold text-foreground hover:bg-accent/30"
          >
            Request another tour
          </button>
          <Link
            href={buildRentalApplyHref({ propertyId: property.id })}
            data-attr="tour-success-apply"
            className="rounded-full border border-primary/30 bg-primary/10 px-5 py-2 text-sm font-semibold text-primary hover:bg-primary/15"
          >
            Apply for this property
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "space-y-6" : "ps-j-stack"}>
      {pub ? (
        <ol className="ps-j-steps" aria-label="Tour steps">
          {steps.map((st) => {
            const reachable = canNavigateToWizardStep(st.n, maxStepReached);
            return (
              <li key={st.n}>
                <button
                  type="button"
                  className="ps-j-step"
                  aria-current={step === st.n ? "step" : undefined}
                  disabled={!reachable}
                  onClick={() => {
                    if (reachable) setStep(st.n as TourStep);
                  }}
                >
                  <span className="ps-j-step-i">{String(st.n).padStart(2, "0")}</span>
                  {st.label}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <>
      <div className="text-sm">
        <p className="font-semibold text-foreground">{property.title}</p>
        {property.address ? <p className="mt-1 text-muted">{property.address}</p> : null}
      </div>

      <div className="flex items-center gap-2 text-sm">
        {steps.map((s, i) => {
          const reachable = canNavigateToWizardStep(s.n, maxStepReached);
          return (
          <div key={s.n} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-6 bg-accent/40" />}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => {
                if (!reachable) return;
                setStep(s.n as TourStep);
              }}
              className={`flex items-center gap-2 ${reachable ? "" : "cursor-not-allowed opacity-45"}`}
            >
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                step === s.n
                  ? "bg-primary text-white"
                  : s.n < step
                  ? "bg-primary/20 text-primary"
                  : "bg-accent/30 text-muted/70"
              }`}>
                {s.n < step ? <CheckSmIcon /> : s.n}
              </span>
              <span className={`hidden sm:inline text-sm ${
                step === s.n ? "font-semibold text-foreground" : "text-muted/70"
              }`}>
                {s.label}
              </span>
            </button>
          </div>
        );
        })}
      </div>
        </>
      )}

      <div className={pub ? undefined : "mt-6"}>
        {step === 1 && (
          <Step2
            pub={pub}
            property={property}
            roomKey={selectedRoomKey}
            onSelectRoom={setSelectedRoomKey}
            occupancySyncEpoch={occupancySyncEpoch}
            availability={selectedAvailability}
            fieldErrors={fieldErrors}
            calMonth={calMonth}
            calYear={calYear}
            onPrevMonth={() => {
              if (calMonth === 0) { setCalMonth(11); setCalYear(y => y - 1); }
              else setCalMonth(m => m - 1);
              setSelectedDay(null);
              setSelectedSlotIndex(null);
            }}
            onNextMonth={() => {
              if (calMonth === 11) { setCalMonth(0); setCalYear(y => y + 1); }
              else setCalMonth(m => m + 1);
              setSelectedDay(null);
              setSelectedSlotIndex(null);
            }}
            selectedDay={selectedDay}
            onSelectDate={(y, m, d) => {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.tourSlot;
                return next;
              });
              setCalYear(y);
              setCalMonth(m);
              setSelectedDay(d);
              setSelectedSlotIndex(null);
              setSubmitError(null);
            }}
            onSelectDay={(day) => {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.tourSlot;
                return next;
              });
              setSelectedDay(day);
              setSelectedSlotIndex(null);
              setSubmitError(null);
            }}
            selectedSlotIndex={selectedSlotIndex}
            onSelectSlotIndex={(slot) => {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.tourSlot;
                return next;
              });
              setSelectedSlotIndex(slot);
              setSubmitError(null);
            }}
            managersAtSelectedSlot={managersAtSelectedSlot}
            availabilityLoading={availabilityLoading}
            availabilityError={availabilityError}
            onRetryAvailability={() => void loadAvailability()}
            requestMode={requestMode}
          />
        )}
        {step === 2 && !contactAutofill.ready && (
          <div className="ps-mute" aria-busy="true">
            Loading…
          </div>
        )}
        {step === 2 && contactAutofill.ready && (
          <Step3
            pub={pub}
            property={property}
            roomLabel={selectedRoomLabel}
            contactDefaults={contactAutofill}
            signedIn={Boolean(signedInUserId)}
            accountNext={accountNext}
            submitError={submitError}
            slotGone={slotGone}
            nextOpenTimes={nextOpenTimes}
            onPickNextOpenTime={(slot) => {
              setCalYear(slot.year);
              setCalMonth(slot.month);
              setSelectedDay(slot.day);
              setSelectedSlotIndex(slot.slotIndex);
              setSubmitError(null);
            }}
            onChangeTime={() => setStep(1)}
            day={selectedDay}
            slotIndex={selectedSlotIndex}
            month={calMonth}
            year={calYear}
            submitting={bookingTour}
            fieldErrors={fieldErrors}
            embeddedModalLayout={embeddedModalLayout}
            onEmbeddedBookFooterChange={embeddedModalLayout ? setDetailsFooter : undefined}
            onFieldChange={(key) =>
              setFieldErrors((prev) => {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
              })
            }
            onSubmit={async ({ name, email, phone, notes, smsConsent, tourFormat }) => {
              if (bookingTour) return;
              setSubmitError(null);
              const errs = validateTourContactFields({ name, email, phone });
              if (Object.keys(errs).length > 0) {
                setFieldErrors(errs);
                showToast("Please fix the highlighted fields before continuing.");
                queueMicrotask(() => scrollToFirstWizardFieldError(TOUR_STEP_FIELD_ORDER[3] ?? [], errs));
                return;
              }
              const normalizedPhone = normalizeTourContactPhone(phone);
              if (!normalizedPhone) {
                const phoneErr = { phone: "Phone number must be 10 digits." };
                setFieldErrors(phoneErr);
                showToast("Please fix the highlighted fields before continuing.");
                queueMicrotask(() => scrollToFirstWizardFieldError(TOUR_STEP_FIELD_ORDER[3] ?? [], phoneErr));
                return;
              }
              if (selectedDay == null || selectedSlotIndex == null) return;
              if (!requestMode && managersAtSelectedSlot.length === 0) {
                setSubmitError("That tour time is no longer available.");
                void loadAvailability();
                return;
              }
              const dateStr = toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0));
              const selectedSlotKey = dateSlotKey(dateStr, selectedSlotIndex);
              // A requested time is Pacific wall time like every slotKey, so its instant is built from the key,
              // never from this browser's own zone.
              const requestedWindow = requestMode ? isoWindowFromSlotKey(selectedSlotKey) : null;
              if (requestMode && !requestedWindow) return;
              const start = requestedWindow ? new Date(requestedWindow.start) : localDateAtSlotStart(dateStr, selectedSlotIndex);
              const end = requestedWindow ? new Date(requestedWindow.end) : new Date(start.getTime() + 30 * 60 * 1000);
              const propertyContext = [
                `Property: ${property.title}`,
                selectedRoomLabel ? `Room: ${selectedRoomLabel}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              setBookingTour(true);
              const tourGroupId = crypto.randomUUID();
              /**
               * ONE request, however many managers could host it.
               *
               * This used to file one inquiry per eligible host, so a single
               * prospect picking a single time produced N pending rows for the
               * same guest at the same hour — the manager's Pending count was
               * hosts, not requests — and whoever clicked Approve first won a
               * race the others could not see.
               *
               * A request is hostless instead: it is filed under one host for
               * record keeping, carries every host who had that slot open, and
               * whoever approves it takes it (`confirmTourInquiry`).
               */
              const eligibleHostUserIds = [
                ...new Set(managersAtSelectedSlot.map((manager) => manager.userId).filter(Boolean)),
              ];
              if (requestMode) {
                // No host to name: the server files it under the property's own host, re-checks that the house
                // still has no open slot, and stamps the kind.
                const result = await appendPartnerInquiryToServer({
                  name: name.trim(),
                  email: email.trim(),
                  phone: normalizedPhone,
                  smsConsent,
                  smsConsentAt: smsConsent ? new Date().toISOString() : undefined,
                  kind: "tour",
                  requestKind: REQUESTED_TOUR_KIND,
                  tourGroupId,
                  propertyId: property.id,
                  propertyTitle: property.title,
                  roomLabel: selectedRoomLabel,
                  tourFormat,
                  notes: [propertyContext, notes.trim()].filter(Boolean).join("\n\n"),
                  requestedWindows: [{ start: start.toISOString(), end: end.toISOString(), slotKey: selectedSlotKey }],
                  proposedStart: start.toISOString(),
                  proposedEnd: end.toISOString(),
                });
                setBookingTour(false);
                if (!result.ok) {
                  // Inline, on the step that asked, with the time still picked: a toast vanishes and a wiped
                  // pick sends a prospect back to square one over a refusal that may only need another try.
                  setSubmitError(result.error ?? "That tour time is no longer available.");
                  void loadAvailability();
                  return;
                }
                const requestedInquiryId = result.row?.id?.trim() ?? "";
                if (signedInUserId && hasResidentRole && requestedInquiryId) {
                  const linked = await linkBookedToursToSignedInResident([requestedInquiryId]);
                  if (!linked) showToast("Your tour was requested but could not be linked to your account yet.");
                }
                setSubmitted(true);
                setSubmittedContact({
                  name: name.trim(),
                  email: email.trim(),
                  phone: formatTourContactPhoneDisplay(normalizedPhone),
                  inquiryId: requestedInquiryId,
                });
                onSuccess();
                return;
              }
              // Filed under the host whose own listing this is, when one of them
              // is; otherwise the first. Only bookkeeping — it does not decide
              // who hosts, and every eligible host sees it either way.
              const filedHost =
                managersAtSelectedSlot.find((manager) => manager.propertyId === property.id) ??
                managersAtSelectedSlot[0]!;
              const results = await Promise.all(
                [filedHost].map((manager) =>
                  appendPartnerInquiryToServer({
                    eligibleHostUserIds,
                    name: name.trim(),
                    email: email.trim(),
                    phone: normalizedPhone,
                    smsConsent,
                    smsConsentAt: smsConsent ? new Date().toISOString() : undefined,
                    kind: "tour",
                    managerUserId: manager.userId,
                    tourGroupId,
                    propertyId: manager.propertyId || property.id,
                    propertyTitle: property.title,
                    roomLabel: selectedRoomLabel,
                    tourFormat,
                    notes: [propertyContext, notes.trim()].filter(Boolean).join("\n\n"),
                    adminUserId: manager.userId,
                    adminLabel: manager.label,
                    requestedWindows: [{
                      start: start.toISOString(),
                      end: end.toISOString(),
                      adminUserId: manager.userId,
                      adminLabel: manager.label,
                      slotKey: selectedSlotKey,
                    }],
                    proposedStart: start.toISOString(),
                    proposedEnd: end.toISOString(),
                  }),
                ),
              );
              setBookingTour(false);
              const failedResult = results.find((item) => !item.ok);
              if (failedResult) {
                setSubmitError(failedResult.error ?? "That tour time is no longer available.");
                void loadAvailability();
                return;
              }
              const inquiryIds = results
                .map((item) => item.row?.id?.trim() ?? "")
                .filter(Boolean);
              if (signedInUserId && hasResidentRole && inquiryIds.length > 0) {
                const linked = await linkBookedToursToSignedInResident(inquiryIds);
                if (!linked) {
                  showToast("Your tour was booked but could not be linked to your account yet.");
                }
              }
              setSubmitted(true);
              const firstInquiryId = inquiryIds[0] ?? "";
              setSubmittedContact({
                name: name.trim(),
                email: email.trim(),
                phone: formatTourContactPhoneDisplay(normalizedPhone),
                inquiryId: firstInquiryId,
              });
              onSuccess();
            }}
          />
        )}
      </div>

      {!embeddedModalLayout && step < 3 ? (
        <div className={pub ? undefined : "mt-6"}>
          <TourStepNavigationFooter pub={pub} step={step} onBack={goToPreviousStep} onContinue={goToNextStep} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The room is never a gate. Several rooms default to "not sure yet" and a dropdown changes it; a house with
 * one room has nothing to pick, so nothing is drawn.
 */
function RoomSelect({
  pub,
  property,
  value,
  onChange,
  occupancySyncEpoch,
}: {
  pub: boolean;
  property: MockProperty;
  value: string | null;
  onChange: (roomKey: string) => void;
  occupancySyncEpoch: number;
}) {
  const listedRooms = roomOptionsForProperty(property);
  void occupancySyncEpoch;
  const roomAvailabilityWarning = tourRoomAvailabilityMessage(value);
  if (listedRooms.length <= 1) return null;
  const select = (
    <select
      id="tour-room"
      value={value ?? TOUR_ROOM_UNDECIDED_KEY}
      onChange={(event) => onChange(event.target.value)}
      className={pub ? "ps-select" : inputCls}
      data-attr="tour-room-select"
      aria-label="Room"
    >
      <option value={TOUR_ROOM_UNDECIDED_KEY}>{TOUR_ROOM_UNDECIDED_LABEL}</option>
      {listedRooms.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className={pub ? "ps-j-stack" : "space-y-3"} style={pub ? { gap: 12 } : undefined} data-wizard-field="room">
      <Field pub={pub} label="Room">
        {select}
      </Field>
      {roomAvailabilityWarning ? (
        <p
          role="status"
          data-attr="tour-room-unavailable"
          className={pub ? "ps-j-note" : "rounded-xl border px-4 py-3 text-sm portal-banner-pending"}
          style={pub ? { margin: 0 } : undefined}
        >
          {roomAvailabilityWarning}
        </p>
      ) : null}
    </div>
  );
}

function Step2({
  pub,
  onSelectDate,
  property,
  roomKey,
  onSelectRoom,
  occupancySyncEpoch,
  availability,
  fieldErrors,
  calMonth, calYear, onPrevMonth, onNextMonth,
  selectedDay, onSelectDay, selectedSlotIndex, onSelectSlotIndex,
  managersAtSelectedSlot,
  availabilityLoading,
  availabilityError,
  onRetryAvailability,
  requestMode,
}: {
  pub: boolean;
  onSelectDate: (year: number, month: number, day: number) => void;
  property: MockProperty;
  roomKey: string | null;
  onSelectRoom: (roomKey: string) => void;
  occupancySyncEpoch: number;
  availability: Set<string>;
  fieldErrors: Record<string, string>;
  calMonth: number; calYear: number;
  onPrevMonth: () => void; onNextMonth: () => void;
  selectedDay: number | null; onSelectDay: (d: number) => void;
  selectedSlotIndex: number | null; onSelectSlotIndex: (slotIndex: number) => void;
  managersAtSelectedSlot: PropertyManagerEntry[];
  availabilityLoading: boolean;
  availabilityError: string | null;
  onRetryAvailability: () => void;
  /** The house has no open slot: any day from tomorrow and any 30-minute time is requestable. */
  requestMode: boolean;
}) {
  const daysInMonth = getDaysInMonth(calYear, calMonth);
  const firstDay = getFirstDayOfMonth(calYear, calMonth);
  // Slot keys are Pacific wall time, so "today" has to be Pacific too. Read from the
  // browser's own calendar, a prospect east of Pacific whose local date has already
  // rolled over is told "No tour times yet" about slots that are still open today, and
  // the cell holding them is drawn as past.
  const todayPacific = pacificCalendarDateYmd();
  const selectedDateStr = selectedDay != null ? toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0)) : null;
  const requestDates = requestMode ? requestedTourDates() : [];
  const openSlots = selectedDateStr
    ? requestMode
      ? requestedTourSlotIndices()
      : openSlotIndicesForDateStr(availability, selectedDateStr)
    : [];
  const slotLabel = (slotIndex: number) =>
    requestMode ? formatRequestedTourTime(slotIndex) : formatAvailabilitySlotLabel(slotIndex);
  const requestCaption =
    requestMode && selectedDateStr && selectedSlotIndex != null ? requestedTourCaption(selectedDateStr, selectedSlotIndex) : null;
  if (pub) {
    const openDates = requestMode ? requestDates : upcomingOpenDates(availability, todayPacific);
    return (
      <div className="ps-j-stack" style={{ gap: 22 }}>
        {availabilityLoading ? (
          <div role="status" aria-label="Loading tour windows">
            <div className="ps-j-skel" aria-hidden>
              {Array.from({ length: 7 }).map((_, i) => (
                <i key={i} />
              ))}
            </div>
            <span className="sr-only">Loading tour windows…</span>
          </div>
        ) : availabilityError ? (
          <div data-attr="tour-availability-read-failed" className="ps-j-note ps-j-note-bad">
            <p>{availabilityError}</p>
            <button type="button" onClick={onRetryAvailability} className="ps-btn ps-btn-line">
              Try again
            </button>
          </div>
        ) : null}
        <RoomSelect
          pub
          property={property}
          value={roomKey}
          onChange={onSelectRoom}
          occupancySyncEpoch={occupancySyncEpoch}
        />

        <div
          data-wizard-field="tourSlot"
          className={`ps-j-stack${fieldErrors.tourSlot ? " ps-j-err" : ""}`}
          style={{ gap: 22 }}
        >
          {openDates.length > 0 ? (
            <div>
              <p className="ps-j-month">Day</p>
              <div className="ps-j-days" role="group" aria-label="Open days">
                {openDates.map((dateStr) => {
                  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
                  const selected = selectedDay === d && calMonth === m - 1 && calYear === y;
                  const weekday = WEEKDAYS_SHORT[new Date(y, m - 1, d, 12, 0, 0, 0).getDay()];
                  return (
                    <button
                      key={dateStr}
                      type="button"
                      className="ps-j-day"
                      aria-pressed={selected}
                      aria-label={`${tourDayLabel(y, m - 1, d)} — ${requestMode ? "request a tour" : "open for tours"}`}
                      onClick={() => onSelectDate(y, m - 1, d)}
                    >
                      <span className="ps-j-day-w">{weekday}</span>
                      <span className="ps-j-day-d">{d}</span>
                      <span className="ps-j-day-w">{MONTHS_SHORT[m - 1]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {selectedDay ? (
            <div>
              <p className="ps-j-month">Time · {tourDayLabel(calYear, calMonth, selectedDay)}</p>
              {openSlots.length === 0 ? (
                <p className="ps-mute" style={{ margin: 0 }}>
                  No tour windows on this day — pick another date above.
                </p>
              ) : (
                <div className="ps-j-times">
                  {openSlots.map((slotIndex) => (
                    <button
                      key={slotIndex}
                      type="button"
                      className="ps-j-time"
                      aria-pressed={selectedSlotIndex === slotIndex}
                      onClick={() => onSelectSlotIndex(slotIndex)}
                    >
                      {slotLabel(slotIndex)}
                    </button>
                  ))}
                </div>
              )}
              {requestCaption ? (
                <p className="ps-mute" style={{ margin: "10px 0 0" }} data-attr="tour-request-caption">
                  {requestCaption}
                </p>
              ) : null}
            </div>
          ) : null}

          {selectedSlotIndex != null && managersAtSelectedSlot.length > 1 ? (
            <p className="ps-mute" style={{ margin: 0 }}>
              We&apos;ll send this request to every available manager for this house. The first manager to approve
              gets the tour.
            </p>
          ) : null}
          {fieldErrors.tourSlot ? <p className="ps-error" style={{ margin: 0 }}>{fieldErrors.tourSlot}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {availabilityLoading ? (
        <p className="rounded-2xl border px-4 py-3 text-sm portal-banner-info">
          Loading tour windows from the calendar...
        </p>
      ) : availabilityError ? (
        <div
          data-attr="tour-availability-read-failed"
          className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm portal-banner-danger"
        >
          <p className="min-w-0 flex-1">{availabilityError}</p>
          <button
            type="button"
            onClick={onRetryAvailability}
            className="rounded-full border border-current px-4 py-1.5 text-xs font-semibold"
          >
            Try again
          </button>
        </div>
      ) : requestMode ? (
        <p className="text-sm text-muted">
          Pick a day and time to request a tour of <span className="font-semibold text-foreground">{property.title}</span>.
        </p>
      ) : (
        <p className="text-sm text-muted">
          Pick an available date for <span className="font-semibold text-foreground">{property.title}</span>.
        </p>
      )}
      <RoomSelect
        pub={false}
        property={property}
        value={roomKey}
        onChange={onSelectRoom}
        occupancySyncEpoch={occupancySyncEpoch}
      />
      <div
        data-wizard-field="tourSlot"
        className={wizardSectionErrorClass(Boolean(fieldErrors.tourSlot), "space-y-4 rounded-2xl")}
      >
      <div className="mx-auto w-full max-w-[17.5rem]">
        <div className="mb-2 flex items-center justify-between">
          <button type="button" onClick={onPrevMonth} className="rounded-full p-1 hover:bg-accent/30">
            <ChevronLeftIcon />
          </button>
          <p className="text-sm font-semibold text-foreground">{MONTHS[calMonth]} {calYear}</p>
          <button type="button" onClick={onNextMonth} className="rounded-full p-1 hover:bg-accent/30">
            <ChevronRightIcon />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {DAYS.map((d) => (
            <div key={d} className="py-0.5 text-center text-[10px] font-semibold uppercase text-muted/70">{d}</div>
          ))}
          {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const cellDateStr = toLocalDateStr(new Date(calYear, calMonth, day, 12, 0, 0, 0));
            const isAvailable = requestMode
              ? requestDates.includes(cellDateStr)
              : dateHasAvailability(new Date(calYear, calMonth, day, 12, 0, 0, 0), availability);
            const isSelected = selectedDay === day;
            const isPast = cellDateStr < todayPacific;
            return (
              <button
                key={day}
                type="button"
                disabled={!isAvailable || isPast}
                onClick={() => onSelectDay(day)}
                className={`flex h-8 items-center justify-center rounded-lg text-xs font-medium transition-all ${
                  isSelected
                    ? "bg-primary text-white shadow-sm ring-2 ring-primary/30"
                    : isAvailable && !isPast
                      ? TOUR_OPEN_DAY_CLASS
                      : "cursor-not-allowed text-foreground/30"
                }`}
                aria-label={
                  isAvailable && !isPast
                    ? `${MONTHS[calMonth]} ${day} — ${requestMode ? "request a tour" : "open for tours"}`
                    : `${MONTHS[calMonth]} ${day} — unavailable`
                }
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>

      {selectedDay ? (
        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">
            {requestMode ? "Request a time" : "Available times"} · {MONTHS[calMonth]} {selectedDay}
          </p>
          {openSlots.length === 0 ? (
            <p className="rounded-xl border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-sm text-muted">
              No tour windows on this day — pick another date above.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {openSlots.map((slotIndex) => (
                <button
                  key={slotIndex}
                  type="button"
                  onClick={() => onSelectSlotIndex(slotIndex)}
                  className={`rounded-lg border py-2 text-[11px] font-semibold transition-all ${
                    selectedSlotIndex === slotIndex
                      ? "border-primary bg-primary text-white"
                      : TOUR_OPEN_SLOT_CLASS
                  }`}
                >
                  {slotLabel(slotIndex)}
                </button>
              ))}
            </div>
          )}
          {requestCaption ? (
            <p className="mt-2 text-xs text-muted" data-attr="tour-request-caption">
              {requestCaption}
            </p>
          ) : null}
        </div>
      ) : null}

      {selectedSlotIndex != null && managersAtSelectedSlot.length > 1 && (
        <div>
          <p className="mb-3 text-sm font-semibold text-foreground">Multiple managers are available</p>
          <p className="mb-3 text-xs text-muted">
            We&apos;ll send this request to every available manager for this house. The first manager to approve gets the tour.
          </p>
        </div>
      )}
      {fieldErrors.tourSlot ? <p className="text-xs font-medium text-red-600">{fieldErrors.tourSlot}</p> : null}
      </div>
    </div>
  );
}

type NextOpenTime = NonNullable<ReturnType<typeof parseTourSlotKey>>;

/**
 * A refusal lives on the step that asked, beside the time that was picked. "That time was just taken" offers
 * the next open times as one-tap replacements; any other refusal (a duplicate request, a rate limit, a closed
 * calendar) shows the server's own words. The chosen time is never wiped.
 */
function TourRefusal({
  pub,
  slotGone,
  submitError,
  nextOpenTimes,
  onPick,
  onChangeTime,
}: {
  pub: boolean;
  slotGone: boolean;
  submitError: string | null;
  nextOpenTimes: NextOpenTime[];
  onPick: (slot: NextOpenTime) => void;
  onChangeTime: () => void;
}) {
  if (slotGone) {
    return (
      <div
        role="alert"
        data-attr="tour-slot-taken"
        className={pub ? "ps-j-note ps-j-note-bad" : "rounded-xl border px-4 py-3 text-sm portal-banner-danger"}
      >
        <p style={{ margin: 0, fontWeight: 600 }}>That time was just taken.</p>
        {nextOpenTimes.length > 0 ? (
          <div className={pub ? "ps-j-times" : "mt-2 flex flex-wrap gap-2"} style={pub ? { marginTop: 10 } : undefined}>
            {nextOpenTimes.map((slot) => (
              <button
                key={slot.slotKey}
                type="button"
                data-attr="tour-next-open-time"
                className={pub ? "ps-j-time" : "rounded-full border border-current px-3 py-1 text-xs font-semibold"}
                onClick={() => onPick(slot)}
              >
                {WEEKDAYS_SHORT[new Date(slot.year, slot.month, slot.day, 12, 0, 0, 0).getDay()]} {MONTHS_SHORT[slot.month]}{" "}
                {slot.day} · {formatAvailabilitySlotLabel(slot.slotIndex)}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            className={pub ? "ps-btn ps-btn-line" : "mt-2 rounded-full border border-current px-3 py-1 text-xs font-semibold"}
            onClick={onChangeTime}
          >
            Pick another time
          </button>
        )}
      </div>
    );
  }
  if (!submitError) return null;
  return (
    <p
      role="alert"
      data-attr="tour-request-refused"
      className={pub ? "ps-error" : "text-sm font-medium text-red-600"}
      style={{ margin: 0 }}
    >
      {submitError}
    </p>
  );
}

/**
 * "Your details" for a visitor with no account: the account is asked for here, after the room, day and time
 * are chosen. Nothing is written before sign-in - the pick rides the sign-in `next` and
 * `/resident/tour/schedule` finishes the request.
 */
function TourAccountStep({
  pub,
  accountNext,
  summary,
  refusal,
}: {
  pub: boolean;
  accountNext: string;
  summary: ReactNode;
  refusal: ReactNode;
}) {
  const primary = pub ? "ps-btn ps-btn-blue ps-btn-block" : "block w-full rounded-full bg-primary px-5 py-2.5 text-center text-sm font-semibold text-primary-foreground";
  const line = pub ? "ps-link" : "font-semibold text-primary hover:underline";
  return (
    <div className={pub ? "ps-j-stack" : "space-y-4"} style={pub ? { gap: 18 } : undefined} data-attr="tour-account-step">
      {summary}
      {refusal}
      <div className="space-y-3">
        <ResidentAppleSignUpButton nextPath={accountNext} />
        <ResidentGoogleSignUpButton nextPath={accountNext} />
      </div>
      <AuthDivider label="or" />
      <Link
        href={residentCreateAccountHref(accountNext)}
        prefetch={false}
        className={primary}
        data-attr="tour-account-email"
      >
        Continue with email
      </Link>
      <p style={{ margin: 0, textAlign: "center" }}>
        <Link href={residentSignInHref(accountNext)} prefetch={false} className={line} data-attr="tour-step-sign-in">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function Step3({
  pub,
  property, roomLabel, day, slotIndex, month, year, submitting, onSubmit, fieldErrors, onFieldChange,
  contactDefaults, embeddedModalLayout, onEmbeddedBookFooterChange, signedIn,
  accountNext, submitError, slotGone, nextOpenTimes, onPickNextOpenTime, onChangeTime,
}: {
  pub: boolean;
  property: MockProperty; roomLabel: string; day: number | null; slotIndex: number | null;
  month: number;
  year: number;
  submitting: boolean;
  fieldErrors: Record<string, string>;
  contactDefaults: ProspectContactAutofill;
  /** A signed-in resident already has an account and has already consented. */
  signedIn: boolean;
  /** Where sign-in / sign-up lands with this room, day and time preselected. */
  accountNext: string;
  submitError: string | null;
  /** The picked time is no longer on offer. */
  slotGone: boolean;
  nextOpenTimes: NextOpenTime[];
  onPickNextOpenTime: (slot: NextOpenTime) => void;
  onChangeTime: () => void;
  embeddedModalLayout?: boolean;
  onEmbeddedBookFooterChange?: (footer: ReactNode | null) => void;
  onFieldChange: (key: string) => void;
  onSubmit: (payload: { name: string; email: string; phone: string; notes: string; smsConsent: boolean; tourFormat: TourFormat }) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [tourFormat, setTourFormat] = useState<TourFormat>(DEFAULT_TOUR_FORMAT);
  // Signed-in residents consented when their account was created; the tick is
  // not shown to them, so it must not silently submit as "declined".
  const [smsConsent] = useState(signedIn);
  const onSubmitRef = useRef(onSubmit);
  // Synced in an effect rather than during render; the ref is only read from the
  // submit handler, well after the effect has flushed.
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    if (!contactDefaults.ready) return;
    if (contactDefaults.name) setName((prev) => prev || contactDefaults.name);
    if (contactDefaults.email) setEmail((prev) => prev || contactDefaults.email);
    if (contactDefaults.phone) setPhone((prev) => prev || contactDefaults.phone);
  }, [contactDefaults.ready, contactDefaults.name, contactDefaults.email, contactDefaults.phone]);

  useEffect(() => {
    if (!embeddedModalLayout || !onEmbeddedBookFooterChange || !signedIn) return;
    onEmbeddedBookFooterChange(
      <Button
        type="button"
        variant="primary"
        className="h-9 min-h-0 rounded-full px-6 text-[13px]"
        disabled={submitting || slotGone}
        onClick={() => onSubmitRef.current({ name, email, phone, notes, smsConsent, tourFormat })}
        data-attr="tour-book-submit"
      >
        {submitting ? "Requesting…" : "Request tour"}
      </Button>,
    );
    return () => onEmbeddedBookFooterChange(null);
  }, [
    embeddedModalLayout,
    email,
    name,
    notes,
    onEmbeddedBookFooterChange,
    phone,
    signedIn,
    slotGone,
    smsConsent,
    submitting,
    tourFormat,
  ]);

  const refusal = (
    <TourRefusal
      pub={pub}
      slotGone={slotGone}
      submitError={submitError}
      nextOpenTimes={nextOpenTimes}
      onPick={onPickNextOpenTime}
      onChangeTime={onChangeTime}
    />
  );

  if (pub) {
    const summary = (
      <ul className="ps-facts" data-attr="tour-confirm-summary">
        <li>
          <span>Home</span>
          <span>{property.title}</span>
        </li>
        {day != null ? (
          <li>
            <span>Day</span>
            <span>{tourDayLabel(year, month, day)}</span>
          </li>
        ) : null}
        {slotIndex != null ? (
          <li>
            <span>Time</span>
            <span>{formatAvailabilitySlotLabel(slotIndex)}</span>
          </li>
        ) : null}
        {roomLabel ? (
          <li>
            <span>Room</span>
            <span>{roomLabel}</span>
          </li>
        ) : null}
      </ul>
    );

    if (!signedIn) {
      return <TourAccountStep pub accountNext={accountNext} summary={summary} refusal={refusal} />;
    }

    return (
      <div className="ps-j-stack" style={{ gap: 22 }}>
        {summary}
        {refusal}

        <div className="ps-j-grid2">
          <Field pub label="Name *" fieldKey="name" error={fieldErrors.name}>
            <input
              id="tour-name"
              type="text"
              value={name}
              onChange={(e) => {
                onFieldChange("name");
                setName(e.target.value);
              }}
              placeholder="Jane Smith"
              className={wizardFieldErrorClass(Boolean(fieldErrors.name), PS_INPUT_CLS)}
            />
          </Field>
          <Field pub label="Email *" fieldKey="email" error={fieldErrors.email}>
            <input
              id="tour-email"
              type="email"
              value={email}
              onChange={(e) => {
                onFieldChange("email");
                setEmail(e.target.value);
              }}
              placeholder="jane@email.com"
              className={wizardFieldErrorClass(Boolean(fieldErrors.email), PS_INPUT_CLS)}
            />
          </Field>
        </div>
        <Field pub label="Phone *" fieldKey="phone" error={fieldErrors.phone}>
          <PhoneNumberField
            id="tour-phone"
            value={phone}
            onChange={(next) => {
              onFieldChange("phone");
              setPhone(next);
            }}
            inputClassName={wizardFieldErrorClass(Boolean(fieldErrors.phone), "")}
            dataAttr="tour-phone"
          />
        </Field>
        <Field pub label="Tour format">
          <div role="radiogroup" aria-label="Tour format" className="ps-j-radios" data-attr="tour-format">
            {TOUR_FORMAT_OPTIONS.map((option) => {
              const selected = tourFormat === option.value;
              return (
                <label key={option.value} className="ps-j-radio" data-on={selected} title={option.hint}>
                  <input
                    type="radio"
                    name="tour-format"
                    value={option.value}
                    checked={selected}
                    onChange={() => setTourFormat(option.value)}
                    data-attr={`tour-format-${option.value}`}
                  />
                  <b>{option.label}</b>
                </label>
              );
            })}
          </div>
        </Field>
        <Field pub label="Notes (optional)">
          <textarea
            id="tour-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything we should prepare in advance?"
            className={`${PS_INPUT_CLS} resize-none`}
          />
        </Field>

        <button
          type="button"
          disabled={submitting || slotGone}
          onClick={() => onSubmit({ name, email, phone, notes, smsConsent, tourFormat })}
          className="ps-btn ps-btn-blue ps-btn-block"
          data-attr="tour-book-submit"
        >
          {submitting ? "Requesting…" : "Request tour"}
        </button>
      </div>
    );
  }

  const embeddedSummary = (
    <>
      <p className="text-sm font-semibold text-foreground">{roomLabel || property.title}</p>
      <p className="text-sm text-muted">
        {MONTHS[month]} {day}, {year} · {slotIndex != null ? formatAvailabilitySlotLabel(slotIndex) : ""}
      </p>
    </>
  );

  if (!signedIn) {
    return <TourAccountStep pub={false} accountNext={accountNext} summary={embeddedSummary} refusal={refusal} />;
  }

  return (
    <div className="space-y-5">
      {embeddedSummary}
      {refusal}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name *" fieldKey="name" error={fieldErrors.name}>
          <input
            id="tour-name"
            type="text"
            value={name}
            onChange={(e) => {
              onFieldChange("name");
              setName(e.target.value);
            }}
            placeholder="Jane Smith"
            className={wizardFieldErrorClass(Boolean(fieldErrors.name), inputCls)}
          />
        </Field>
        <Field label="Email *" fieldKey="email" error={fieldErrors.email}>
          <input
            id="tour-email"
            type="email"
            value={email}
            onChange={(e) => {
              onFieldChange("email");
              setEmail(e.target.value);
            }}
            placeholder="jane@email.com"
            className={wizardFieldErrorClass(Boolean(fieldErrors.email), inputCls)}
          />
        </Field>
      </div>
      <Field label="Phone *" fieldKey="phone" error={fieldErrors.phone}>
        <PhoneNumberField
          id="tour-phone"
          value={phone}
          onChange={(next) => {
            onFieldChange("phone");
            setPhone(next);
          }}
          inputClassName={wizardFieldErrorClass(Boolean(fieldErrors.phone), "")}
          dataAttr="tour-phone"
        />
      </Field>
      <Field label="Tour format">
        <div role="radiogroup" aria-label="Tour format" className="grid gap-2 sm:grid-cols-2" data-attr="tour-format">
          {TOUR_FORMAT_OPTIONS.map((option) => {
            const selected = tourFormat === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                  selected ? "border-primary bg-primary/5" : "border-border bg-accent/30 hover:border-primary/40"
                }`}
              >
                <input
                  type="radio"
                  name="tour-format"
                  value={option.value}
                  checked={selected}
                  onChange={() => setTourFormat(option.value)}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                  data-attr={`tour-format-${option.value}`}
                />
                <span>
                  <span className="block font-semibold text-foreground">{option.label}</span>
                  <span className="block text-xs text-muted">{option.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </Field>
      <Field label="Notes (optional)">
        <textarea id="tour-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything we should prepare in advance?" className={`${inputCls} resize-none`} />
      </Field>

      {!embeddedModalLayout ? (
        <button
          type="button"
          disabled={submitting || slotGone}
          onClick={() => onSubmit({ name, email, phone, notes, smsConsent, tourFormat })}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(0,122,255,0.28)] transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ background: "linear-gradient(135deg, var(--primary), var(--primary-alt))" }}
          data-attr="tour-book-submit"
        >
          {submitting ? "Requesting…" : "Request tour"}
        </button>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
  fieldKey,
  error,
  pub = false,
}: {
  label: string;
  children: ReactNode;
  fieldKey?: string;
  error?: string;
  pub?: boolean;
}) {
  if (pub) {
    return (
      <div className="ps-field" data-wizard-field={fieldKey}>
        <span>{label}</span>
        {children}
        {error ? <span className="ps-error">{error}</span> : null}
      </div>
    );
  }
  return (
    <div data-wizard-field={fieldKey}>
      <p className="mb-1.5 text-xs font-semibold text-muted">{label}</p>
      {children}
      {error ? <p className="mt-1 text-xs font-medium text-red-600">{error}</p> : null}
    </div>
  );
}

const PS_INPUT_CLS = "ps-input";

const inputCls =
  "w-full rounded-xl border border-border bg-accent/30 px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted/70 focus:border-primary focus:bg-card focus:ring-2 focus:ring-primary/15 hover:border-border";

function CheckSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
