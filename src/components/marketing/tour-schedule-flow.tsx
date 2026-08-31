"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { MockProperty } from "@/data/types";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  appendPartnerInquiryToServer,
  dateHasAvailability,
  dateSlotKey,
  formatAvailabilitySlotLabel,
  localDateAtSlotStart,
  type PropertyManagerEntry,
  toLocalDateStr,
} from "@/lib/demo-admin-scheduling";
import { SmsConsentCheckbox } from "@/components/marketing/sms-consent-checkbox";
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
import {
  PropertySearchPicker,
  type PropertySearchOption,
} from "@/components/marketing/property-search-picker";
import { canNavigateToWizardStep, nextWizardMaxReached } from "@/lib/wizard-step-nav";
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

type TourStep = 1 | 2 | 3;

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
 * "No tour windows are published for this property yet" is a confident claim
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
        const parts = [room.name.trim(), room.floor.trim(), room.monthlyRent > 0 ? `$${room.monthlyRent}/mo` : ""].filter(Boolean);
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
      label: `${p.buildingName} · ${p.unitLabel}`,
      subtitle: `${p.neighborhood} · ${p.rentLabel}`,
      property: p,
    },
  ];
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
function TourStepNavigationFooter({
  step,
  onBack,
  onContinue,
}: {
  step: TourStep;
  onBack: () => void;
  onContinue: () => void;
}) {
  if (step >= 3) return null;
  return (
    <div className={`flex w-full ${step > 1 ? "justify-between" : "justify-end"}`}>
      {step > 1 ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-border px-5 py-2 text-sm font-semibold text-muted hover:bg-accent/30"
        >
          Back
        </button>
      ) : null}
      <button
        type="button"
        onClick={onContinue}
        className="rounded-full bg-primary px-7 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-105"
      >
        Continue
      </button>
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
}: {
  property: MockProperty;
  returnAfterAuth: string;
  onSuccess: () => void;
  embedded?: boolean;
  /** Resident portal modal: pin Back/Continue below the assistant strip via {@link onEmbeddedFooterChange}. */
  embeddedModalLayout?: boolean;
  onEmbeddedFooterChange?: (footer: ReactNode | null) => void;
}) {
  const { showToast } = useAppUi();
  const [step, setStep] = useState<TourStep>(1);
  const [maxStepReached, setMaxStepReached] = useState<TourStep>(1);
  const [submitted, setSubmitted] = useState(false);
  const [submittedContact, setSubmittedContact] = useState<{
    name: string;
    email: string;
    phone: string;
    inquiryId: string;
  } | null>(null);
  const contactAutofill = useProspectContactAutofill();
  const signedInUserId = contactAutofill.userId;
  const hasResidentRole = contactAutofill.hasResidentRole;
  const [tick, setTick] = useState(0);
  const [selectedRoomKey, setSelectedRoomKey] = useState<string | null>(null);
  const selectedRoomLabel = useMemo(
    () => tourRoomLabelForKey(property, selectedRoomKey),
    [property, selectedRoomKey],
  );

  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [slotHosts, setSlotHosts] = useState<Record<string, PropertyManagerEntry[]>>({});
  // Starts true: an availability fetch always runs on mount, and it is deferred
  // behind a microtask. Starting false made the first paint claim "No tour
  // windows are published" before the request had even been sent.
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [bookingTour, setBookingTour] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
    { n: 1, label: "Room" },
    { n: 2, label: "Date & time" },
    { n: 3, label: "Your details" },
  ];

  const goToPreviousStep = useCallback(() => {
    setStep((current) => (current - 1) as TourStep);
  }, []);

  const goToNextStep = useCallback(() => {
    const errs: Record<string, string> = {};
    if (step === 1) {
      if (!selectedRoomKey) errs.room = "Choose a room to tour, or select not sure yet.";
    }
    if (step === 2) {
      if (selectedDay === null || selectedSlotIndex === null || managersAtSelectedSlot.length === 0) {
        errs.tourSlot = "Select a date and time for your tour.";
      }
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      showToast("Please fix the highlighted fields before continuing.");
      queueMicrotask(() => scrollToFirstWizardFieldError(TOUR_STEP_FIELD_ORDER[step] ?? [], errs));
      return;
    }
    setFieldErrors({});
    const next = (step + 1) as TourStep;
    setStep(next);
    setMaxStepReached((m) => nextWizardMaxReached(m, next) as TourStep);
  }, [
    managersAtSelectedSlot.length,
    selectedDay,
    selectedRoomKey,
    selectedSlotIndex,
    showToast,
    step,
  ]);

  useEffect(() => {
    if (!embeddedModalLayout || !onEmbeddedFooterChange) return;
    if (submitted || step >= 3) {
      onEmbeddedFooterChange(null);
      return;
    }
    onEmbeddedFooterChange(
      <TourStepNavigationFooter step={step} onBack={goToPreviousStep} onContinue={goToNextStep} />,
    );
    return () => onEmbeddedFooterChange(null);
  }, [
    embeddedModalLayout,
    goToNextStep,
    goToPreviousStep,
    onEmbeddedFooterChange,
    step,
    submitted,
  ]);

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
    <div className={embedded ? "space-y-6" : PUBLIC_PROSPECT_CANVAS_CLASS}>
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

      <div className="mt-6">
        {step === 1 && (
          <Step1
            property={property}
            onSelectRoom={(roomKey) => {
              if (!roomKey) {
                setSelectedRoomKey(null);
                setSlotHosts({});
                setSelectedDay(null);
                setSelectedSlotIndex(null);
                return;
              }
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.room;
                return next;
              });
              setSelectedRoomKey(roomKey);
              setSelectedDay(null);
              setSelectedSlotIndex(null);
            }}
            selectedRoomKey={selectedRoomKey}
            fieldErrors={fieldErrors}
          />
        )}
        {step === 2 && (
          <Step2
            property={property}
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
            onSelectDay={(day) => {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.tourSlot;
                return next;
              });
              setSelectedDay(day);
              setSelectedSlotIndex(null);
            }}
            selectedSlotIndex={selectedSlotIndex}
            onSelectSlotIndex={(slot) => {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.tourSlot;
                return next;
              });
              setSelectedSlotIndex(slot);
            }}
            managersAtSelectedSlot={managersAtSelectedSlot}
            availabilityLoading={availabilityLoading}
            availabilityError={availabilityError}
            onRetryAvailability={() => void loadAvailability()}
          />
        )}
        {step === 3 && (
          <Step3
            property={property}
            roomLabel={selectedRoomLabel}
            contactDefaults={contactAutofill}
            day={selectedDay}
            slotIndex={selectedSlotIndex}
            month={calMonth}
            year={calYear}
            submitting={bookingTour}
            fieldErrors={fieldErrors}
            returnAfterAuth={returnAfterAuth}
            onFieldChange={(key) =>
              setFieldErrors((prev) => {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
              })
            }
            onSubmit={async ({ name, email, phone, notes, smsConsent }) => {
              if (bookingTour) return;
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
              if (managersAtSelectedSlot.length === 0) {
                showToast("That tour time is no longer available.");
                return;
              }
              const dateStr = toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0));
              const start = localDateAtSlotStart(dateStr, selectedSlotIndex);
              const end = new Date(start.getTime() + 30 * 60 * 1000);
              const selectedSlotKey = dateSlotKey(dateStr, selectedSlotIndex);
              const propertyContext = [
                `Property: ${property.title}`,
                selectedRoomLabel ? `Room: ${selectedRoomLabel}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              setBookingTour(true);
              const tourGroupId = crypto.randomUUID();
              const results = await Promise.all(
                managersAtSelectedSlot.map((manager) =>
                  appendPartnerInquiryToServer({
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
                showToast(failedResult.error ?? "That tour time is no longer available.");
                setStep(2);
                setSelectedSlotIndex(null);
                void loadAvailability();
                return;
              }
              const inquiryIds = results
                .map((item) => item.row?.id?.trim() ?? "")
                .filter(Boolean);
              if (signedInUserId && inquiryIds.length > 0) {
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
        <div className="mt-6">
          <TourStepNavigationFooter step={step} onBack={goToPreviousStep} onContinue={goToNextStep} />
        </div>
      ) : null}
    </div>
  );
}

function Step1({
  property,
  onSelectRoom,
  selectedRoomKey,
  fieldErrors,
}: {
  property: MockProperty;
  onSelectRoom: (roomKey: string | null) => void;
  selectedRoomKey: string | null;
  fieldErrors: Record<string, string>;
}) {
  const listedRooms = roomOptionsForProperty(property);
  const showUndecided = listedRooms.length > 1;
  const roomOptions: PropertySearchOption[] = listedRooms.map((option) => ({
    id: option.key,
    title: option.label,
    subtitle: option.subtitle,
    tags: [property.address, property.neighborhood, `Available ${property.available}`],
    searchText: `${option.label} ${option.subtitle} ${property.address} ${property.neighborhood} ${property.rentLabel}`,
  }));
  const undecidedSelected = isTourRoomUndecided(selectedRoomKey);
  const pickerValue = undecidedSelected ? null : selectedRoomKey;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {showUndecided
          ? "Choose a room to tour, or let us know if you are still deciding."
          : "Choose the room you would like to tour."}
      </p>
      {showUndecided ? (
        <button
          type="button"
          data-attr="tour-room-undecided"
          onClick={() => onSelectRoom(TOUR_ROOM_UNDECIDED_KEY)}
          className={`w-full rounded-2xl border px-4 py-3 text-left text-sm transition ${
            undecidedSelected
              ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/25"
              : "border-border/70 bg-card/60 text-foreground hover:border-primary/35 hover:bg-accent/30"
          }`}
        >
          <span className="font-semibold">{TOUR_ROOM_UNDECIDED_LABEL}</span>
          <span className="mt-1 block text-xs text-muted">
            Tour the home and compare rooms with the manager on site.
          </span>
        </button>
      ) : null}
      <div data-wizard-field="room" className={wizardSectionErrorClass(Boolean(fieldErrors.room))}>
        {showUndecided ? (
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Or pick a specific room</p>
        ) : null}
        <PropertySearchPicker
          options={roomOptions}
          value={pickerValue}
          onChange={onSelectRoom}
          placeholder="Search rooms by name, floor, or rent…"
          emptyMessage="No rooms match your search."
          listEmptyMessage="No rooms listed for this property."
          ariaLabel="Search rooms to tour"
          itemNoun="room"
          itemNounPlural="rooms"
        />
        {fieldErrors.room ? <p className="mt-2 text-xs font-medium text-red-600">{fieldErrors.room}</p> : null}
      </div>
    </div>
  );
}

function Step2({
  property,
  availability,
  fieldErrors,
  calMonth, calYear, onPrevMonth, onNextMonth,
  selectedDay, onSelectDay, selectedSlotIndex, onSelectSlotIndex,
  managersAtSelectedSlot,
  availabilityLoading,
  availabilityError,
  onRetryAvailability,
}: {
  property: MockProperty;
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
}) {
  const daysInMonth = getDaysInMonth(calYear, calMonth);
  const firstDay = getFirstDayOfMonth(calYear, calMonth);
  const today = new Date();
  const selectedDateStr = selectedDay != null ? toLocalDateStr(new Date(calYear, calMonth, selectedDay, 12, 0, 0, 0)) : null;
  const openSlots = selectedDateStr ? openSlotIndicesForDateStr(availability, selectedDateStr) : [];

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
      ) : availability.size === 0 ? (
        <p className="rounded-2xl border px-4 py-3 text-sm portal-banner-pending">
          No tour windows are published for this property yet. Send a message to PropLane or ask your property manager.
        </p>
      ) : (
        <p className="text-sm text-muted">
          Pick an available date for <span className="font-semibold text-foreground">{property.title}</span>.
        </p>
      )}
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
            const isAvailable = dateHasAvailability(new Date(calYear, calMonth, day, 12, 0, 0, 0), availability);
            const isSelected = selectedDay === day;
            const isPast = calYear === today.getFullYear() && calMonth === today.getMonth() && day < today.getDate();
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
                    ? `${MONTHS[calMonth]} ${day} — open for tours`
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
            Available times · {MONTHS[calMonth]} {selectedDay}
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
                  {formatAvailabilitySlotLabel(slotIndex)}
                </button>
              ))}
            </div>
          )}
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

function Step3({
  property, roomLabel, day, slotIndex, month, year, submitting, onSubmit, fieldErrors, onFieldChange,
  returnAfterAuth, contactDefaults,
}: {
  property: MockProperty; roomLabel: string; day: number | null; slotIndex: number | null;
  month: number;
  year: number;
  submitting: boolean;
  fieldErrors: Record<string, string>;
  returnAfterAuth: string;
  contactDefaults: ProspectContactAutofill;
  onFieldChange: (key: string) => void;
  onSubmit: (payload: { name: string; email: string; phone: string; notes: string; smsConsent: boolean }) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const signInHref = residentSignInHref(returnAfterAuth);

  useEffect(() => {
    if (!contactDefaults.ready) return;
    if (contactDefaults.name) setName((prev) => prev || contactDefaults.name);
    if (contactDefaults.email) setEmail((prev) => prev || contactDefaults.email);
    if (contactDefaults.phone) setPhone((prev) => prev || contactDefaults.phone);
  }, [contactDefaults.ready, contactDefaults.name, contactDefaults.email, contactDefaults.phone]);

  return (
    <div className="space-y-5">
      <p className="text-sm font-semibold text-foreground">{roomLabel || property.title}</p>
      <p className="text-sm text-muted">
        {MONTHS[month]} {day}, {year} · {slotIndex != null ? formatAvailabilitySlotLabel(slotIndex) : ""}
      </p>

      <p className="text-sm leading-relaxed text-muted">
        No account is required to book a tour. Add your contact details below, or{" "}
        <Link href={signInHref} data-attr="tour-step-sign-in" className="font-semibold text-primary hover:underline">
          sign in
        </Link>{" "}
        if you already have one.
      </p>

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
        <input
          id="tour-phone"
          type="tel"
          value={phone}
          onChange={(e) => {
            onFieldChange("phone");
            setPhone(e.target.value);
          }}
          placeholder="(206) 555-0100"
          className={wizardFieldErrorClass(Boolean(fieldErrors.phone), inputCls)}
        />
      </Field>
      <Field label="Notes (optional)">
        <textarea id="tour-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything we should prepare in advance?" className={`${inputCls} resize-none`} />
      </Field>

      <SmsConsentCheckbox checked={smsConsent} onChange={setSmsConsent} inputId="tour-sms-consent" />

      <button
        type="button"
        disabled={submitting}
        onClick={() => onSubmit({ name, email, phone, notes, smsConsent })}
        className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(0,122,255,0.28)] transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: "linear-gradient(135deg, var(--primary), var(--primary-alt))" }}
        data-attr="tour-book-submit"
      >
        {submitting ? "Booking..." : "Book tour"}
      </button>
    </div>
  );
}

function Field({
  label,
  children,
  fieldKey,
  error,
}: {
  label: string;
  children: ReactNode;
  fieldKey?: string;
  error?: string;
}) {
  return (
    <div data-wizard-field={fieldKey}>
      <p className="mb-1.5 text-xs font-semibold text-muted">{label}</p>
      {children}
      {error ? <p className="mt-1 text-xs font-medium text-red-600">{error}</p> : null}
    </div>
  );
}

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
