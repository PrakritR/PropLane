"use client";

/**
 * The resident "Schedule tour" pop-up for the home demo: `ResidentScheduleTourModal`'s two steps, drawn with the
 * real `Modal`. Step 0 is "Choose a home to tour" (the real `PropertySearchPicker`, footer "Browse homes" +
 * "Continue"); step 1 is the same Modal titled "Schedule tour" hosting the three-step flow of `TourScheduleFlow`
 * (Room · Date & time · Your details, footer Back + Continue, "Book tour" on the last). `TourScheduleFlow` itself
 * loads the host's calendar from the network and files the request, so the flow is drawn here from the same
 * pieces and copy with a sample calendar. Nothing is sent: "Book tour" closes and the panel toasts "(sample)".
 * Loaded on demand (`demo-popups-lazy-resident.tsx`).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { PopupSubjectCard } from "@/components/portal/popup-live-preview";
import { PropertySearchPicker } from "@/components/marketing/property-search-picker";
import { canNavigateToWizardStep, nextWizardMaxReached } from "@/lib/wizard-step-nav";
import { DEFAULT_TOUR_FORMAT, TOUR_FORMAT_OPTIONS, type TourFormat } from "@/lib/tour-format";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import {
  DEMO_HOME_OPTIONS,
  DEMO_TOUR_SLOTS,
  RESIDENT_CONTACT,
  demoRoomsFor,
} from "@/components/marketing/site/product-mock/fixtures-popups-resident";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const UNDECIDED_KEY = "__tour-room-undecided__";
const TOUR_OPEN_DAY_CLASS = "bg-primary/12 text-primary ring-1 ring-inset ring-primary/25 hover:bg-primary/20";
const TOUR_OPEN_SLOT_CLASS = "border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/15";
const inputCls =
  "w-full rounded-xl border border-border bg-accent/30 px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted/70 focus:border-primary focus:bg-card focus:ring-2 focus:ring-primary/15 hover:border-border";

type TourStep = 1 | 2 | 3;

function CheckSm() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-muted">{label}</p>
      {children}
    </div>
  );
}

/** The sample host calendar: weekdays from tomorrow, two weeks out, each with the same published windows. */
function openDays(now: Date): Set<string> {
  const open = new Set<string>();
  for (let offset = 1; offset <= 14; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
    if (day.getDay() !== 0 && day.getDay() !== 6) open.add(`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`);
  }
  return open;
}

function StepFooter({ step, onBack, onContinue }: { step: TourStep; onBack: () => void; onContinue: () => void }) {
  return (
    <div className={`flex w-full ${step > 1 ? "justify-between" : "justify-end"}`}>
      {step > 1 ? (
        <Button type="button" variant="outline" className="h-9 min-h-0 rounded-full px-4 text-[13px]" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <Button type="button" variant="primary" className="h-9 min-h-0 rounded-full px-6 text-[13px]" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

function TourFlow({
  propertyId,
  onFooterChange,
  onBook,
}: {
  propertyId: string;
  onFooterChange: (footer: ReactNode | null) => void;
  onBook: () => void;
}) {
  const home = PROPERTY_ROWS.find((p) => p.id === propertyId) ?? PROPERTY_ROWS[0]!;
  const rooms = useMemo(() => demoRoomsFor(home.id), [home.id]);
  const [now] = useState(() => new Date());
  const open = useMemo(() => openDays(now), [now]);
  const [step, setStep] = useState<TourStep>(1);
  const [maxStep, setMaxStep] = useState<TourStep>(1);
  const [roomKey, setRoomKey] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState(now.getMonth());
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [day, setDay] = useState<number | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(RESIDENT_CONTACT.name);
  const [email, setEmail] = useState(RESIDENT_CONTACT.email);
  const [phone, setPhone] = useState(RESIDENT_CONTACT.phone);
  const [notes, setNotes] = useState("");
  const [format, setFormat] = useState<TourFormat>(DEFAULT_TOUR_FORMAT);

  const roomLabel = roomKey === UNDECIDED_KEY ? "Not sure which room yet" : rooms.find((r) => r.id === roomKey)?.title ?? home.title;

  const next = () => {
    if (step === 1 && !roomKey) {
      setErrors({ room: "Choose a room to tour, or select not sure yet." });
      return;
    }
    if (step === 2 && (day === null || slot === null)) {
      setErrors({ tourSlot: "Select a date and time for your tour." });
      return;
    }
    setErrors({});
    const to = (step + 1) as TourStep;
    setStep(to);
    setMaxStep((m) => nextWizardMaxReached(m, to) as TourStep);
  };

  useEffect(() => {
    if (step < 3) {
      onFooterChange(<StepFooter step={step} onBack={() => setStep((s) => (s - 1) as TourStep)} onContinue={next} />);
    } else {
      onFooterChange(
        <Button type="button" variant="primary" className="h-9 min-h-0 rounded-full px-6 text-[13px]" onClick={onBook} data-attr="tour-book-submit">
          Book tour
        </Button>,
      );
    }
    return () => onFooterChange(null);
    // `next` closes over the current step and picks, which are all in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, roomKey, day, slot, onFooterChange, onBook]);

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const stepper = [
    { n: 1, label: "Room" },
    { n: 2, label: "Date & time" },
    { n: 3, label: "Your details" },
  ];
  const move = (delta: number) => {
    const target = new Date(calYear, calMonth + delta, 1);
    setCalMonth(target.getMonth());
    setCalYear(target.getFullYear());
    setDay(null);
    setSlot(null);
  };

  return (
    <div className="space-y-6" data-attr="demo-tour-flow">
      <div className="text-sm">
        <p className="font-semibold text-foreground">{home.title}</p>
        <p className="mt-1 text-muted">{`${home.street}, Seattle`}</p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {stepper.map((s, i) => {
          const reachable = canNavigateToWizardStep(s.n, maxStep);
          return (
            <div key={s.n} className="flex items-center gap-2">
              {i > 0 && <div className="h-px w-6 bg-accent/40" />}
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && setStep(s.n as TourStep)}
                className={`flex items-center gap-2 ${reachable ? "" : "cursor-not-allowed opacity-45"}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    step === s.n ? "bg-primary text-white" : s.n < step ? "bg-primary/20 text-primary" : "bg-accent/30 text-muted/70"
                  }`}
                >
                  {s.n < step ? <CheckSm /> : s.n}
                </span>
                <span className={`hidden text-sm sm:inline ${step === s.n ? "font-semibold text-foreground" : "text-muted/70"}`}>{s.label}</span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        {step === 1 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {rooms.length > 1 ? "Choose a room to tour, or let us know if you are still deciding." : "Choose the room you would like to tour."}
            </p>
            {rooms.length > 1 ? (
              <button
                type="button"
                data-attr="tour-room-undecided"
                onClick={() => {
                  setRoomKey(UNDECIDED_KEY);
                  setErrors({});
                }}
                className={`w-full rounded-2xl border px-4 py-3 text-left text-sm transition ${
                  roomKey === UNDECIDED_KEY
                    ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/25"
                    : "border-border/70 bg-card/60 text-foreground hover:border-primary/35 hover:bg-accent/30"
                }`}
              >
                <span className="font-semibold">Not sure which room yet</span>
                <span className="mt-1 block text-xs text-muted">Tour the home and compare rooms with the manager on site.</span>
              </button>
            ) : null}
            <div>
              {rooms.length > 1 ? <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Or pick a specific room</p> : null}
              <PropertySearchPicker
                options={rooms}
                value={roomKey === UNDECIDED_KEY ? null : roomKey}
                onChange={(id) => {
                  setRoomKey(id);
                  setErrors({});
                }}
                placeholder="Search rooms by name, floor, or rent…"
                emptyMessage="No rooms match your search."
                listEmptyMessage="No rooms listed for this property."
                ariaLabel="Search rooms to tour"
                itemNoun="room"
                itemNounPlural="rooms"
              />
              {errors.room ? <p className="mt-2 text-xs font-medium text-red-600">{errors.room}</p> : null}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Pick an available date for <span className="font-semibold text-foreground">{home.title}</span>.
            </p>
            <div className="space-y-4 rounded-2xl">
              <div className="mx-auto w-full max-w-[17.5rem]">
                <div className="mb-2 flex items-center justify-between">
                  <button type="button" onClick={() => move(-1)} aria-label="Previous month" className="rounded-full p-1 hover:bg-accent/30">
                    ‹
                  </button>
                  <p className="text-sm font-semibold text-foreground">
                    {MONTHS[calMonth]} {calYear}
                  </p>
                  <button type="button" onClick={() => move(1)} aria-label="Next month" className="rounded-full p-1 hover:bg-accent/30">
                    ›
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {DAYS.map((d) => (
                    <div key={d} className="py-0.5 text-center text-[10px] font-semibold uppercase text-muted/70">
                      {d}
                    </div>
                  ))}
                  {Array.from({ length: firstDay }).map((_, i) => (
                    <div key={`e${i}`} />
                  ))}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const dayNumber = i + 1;
                    const available = open.has(`${calYear}-${calMonth}-${dayNumber}`);
                    const selected = day === dayNumber;
                    return (
                      <button
                        key={dayNumber}
                        type="button"
                        disabled={!available}
                        onClick={() => {
                          setDay(dayNumber);
                          setSlot(null);
                          setErrors({});
                        }}
                        className={`flex h-8 items-center justify-center rounded-lg text-xs font-medium transition-all ${
                          selected ? "bg-primary text-white shadow-sm ring-2 ring-primary/30" : available ? TOUR_OPEN_DAY_CLASS : "cursor-not-allowed text-foreground/30"
                        }`}
                        aria-label={available ? `${MONTHS[calMonth]} ${dayNumber} — open for tours` : `${MONTHS[calMonth]} ${dayNumber} — unavailable`}
                      >
                        {dayNumber}
                      </button>
                    );
                  })}
                </div>
              </div>
              {day ? (
                <div>
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    Available times · {MONTHS[calMonth]} {day}
                  </p>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    {DEMO_TOUR_SLOTS.map((label) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => {
                          setSlot(label);
                          setErrors({});
                        }}
                        className={`rounded-lg border py-2 text-[11px] font-semibold transition-all ${slot === label ? "border-primary bg-primary text-white" : TOUR_OPEN_SLOT_CLASS}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {errors.tourSlot ? <p className="text-xs font-medium text-red-600">{errors.tourSlot}</p> : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <p className="text-sm font-semibold text-foreground">{roomLabel}</p>
            <p className="text-sm text-muted">
              {MONTHS[calMonth]} {day}, {calYear} · {slot}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name *">
                <input id="tour-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" className={inputCls} />
              </Field>
              <Field label="Email *">
                <input id="tour-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@email.com" className={inputCls} />
              </Field>
            </div>
            <Field label="Phone *">
              <PhoneNumberField id="tour-phone" value={phone} onChange={setPhone} dataAttr="tour-phone" />
            </Field>
            <Field label="Tour format">
              <div role="radiogroup" aria-label="Tour format" className="grid gap-2 sm:grid-cols-2" data-attr="tour-format">
                {TOUR_FORMAT_OPTIONS.map((option) => {
                  const selected = format === option.value;
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
                        onChange={() => setFormat(option.value)}
                        className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
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
              <textarea
                id="tour-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything we should prepare in advance?"
                className={`${inputCls} resize-none`}
              />
            </Field>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ResidentScheduleTourModal({
  onClose,
  onScheduled,
  initialPropertyId,
}: {
  onClose: () => void;
  onScheduled: () => void;
  /** Rescheduling: skip the picker and open the slot flow on this home. */
  initialPropertyId?: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(initialPropertyId ?? null);
  const [flowId, setFlowId] = useState<string | null>(initialPropertyId ?? null);
  const [flowFooter, setFlowFooter] = useState<ReactNode | null>(null);
  const home = flowId ? PROPERTY_ROWS.find((p) => p.id === flowId) : undefined;

  return (
    <Modal
      open
      presentation="dialog"
      title={home ? "Schedule tour" : "Choose a home to tour"}
      description={home ? undefined : "Pick the home you want to visit. You can request a tour time right here without leaving your tour list."}
      onClose={onClose}
      dense
      contextPanel={home ? <PopupSubjectCard title={home.title} lines={[`${home.street}, Seattle`, home.rentLabel]} /> : undefined}
      previewLabel={home ? "Tour request" : "Preview"}
      panelClassName={home ? "max-w-2xl" : "max-w-lg"}
      footer={
        home ? (
          flowFooter ? <ModalFooter className="w-full">{flowFooter}</ModalFooter> : null
        ) : (
          <ModalFooter>
            <Button type="button" variant="outline" className="rounded-full px-4 text-[13px]" data-attr="resident-tour-browse-homes" onClick={onClose}>
              Browse homes
            </Button>
            <Button type="button" variant="primary" className="rounded-full" data-attr="resident-tour-continue" disabled={!picked} onClick={() => setFlowId(picked)}>
              Continue
            </Button>
          </ModalFooter>
        )
      }
    >
      {home ? (
        <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
          <TourFlow propertyId={home.id} onFooterChange={setFlowFooter} onBook={onScheduled} />
        </div>
      ) : (
        <PropertySearchPicker
          options={DEMO_HOME_OPTIONS}
          value={picked}
          onChange={setPicked}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No homes are available to tour right now."
          ariaLabel="Search homes to tour"
          listFillsAvailableHeight
          className="min-h-0 flex-1"
        />
      )}
    </Modal>
  );
}
