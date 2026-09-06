"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import {
  appendPartnerInquiry,
  dateStrFromCalendar,
  formatAvailabilitySlotLabel,
  isCalendarDayBeforeToday,
  localDateAtSlotStart,
} from "@/lib/demo-admin-scheduling";
import { canNavigateToWizardStep, nextWizardMaxReached } from "@/lib/wizard-step-nav";
import { Select } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  PARTNER_MEETING_STEP_FIELD_ORDER,
  scrollToFirstWizardFieldError,
  wizardFieldErrorClass,
  wizardSectionErrorClass,
} from "@/lib/wizard-field-errors";

type Step = 1 | 2;
type AdminAvailabilityHost = { adminUserId: string; adminLabel: string };

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

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

export function PartnerMeetingScheduler({ showToast }: { showToast: (m: string) => void }) {
  const [step, setStep] = useState<Step>(1);
  const [maxStepReached, setMaxStepReached] = useState<Step>(1);
  const [tick, setTick] = useState(0);
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedSlotKeys, setSelectedSlotKeys] = useState<string[]>([]);
  const [selectedHostBySlot, setSelectedHostBySlot] = useState<Record<string, string>>({});
  const [slotHosts, setSlotHosts] = useState<Record<string, AdminAvailabilityHost[]>>({});
  const [loadingAvailability, setLoadingAvailability] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const bump = useCallback(() => setTick((t) => t + 1), []);

  const loadAvailability = useCallback(async () => {
    setLoadingAvailability(true);
    try {
      const res = await fetch("/api/public/admin-availability");
      const body = (await res.json()) as { slotHosts?: Record<string, AdminAvailabilityHost[]> };
      setSlotHosts(res.ok && body.slotHosts ? body.slotHosts : {});
    } catch {
      setSlotHosts({});
    } finally {
      setLoadingAvailability(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void loadAvailability(), 0);
    return () => window.clearTimeout(id);
  }, [loadAvailability, tick]);

  useEffect(() => {
    const on = () => bump();
    window.addEventListener(ADMIN_UI_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(ADMIN_UI_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, [bump]);

  const hasAnyPublished = Object.keys(slotHosts).length > 0;

  const selectedDateStr =
    selectedDay != null ? dateStrFromCalendar(calYear, calMonth, selectedDay) : null;
  const openSlots = selectedDateStr
    ? Object.keys(slotHosts)
        .filter((key) => key.startsWith(`${selectedDateStr}:`) && (slotHosts[key]?.length ?? 0) > 0)
        .map((key) => Number.parseInt(key.split(":")[1] ?? "", 10))
        .filter((slot) => Number.isFinite(slot))
        .sort((a, b) => a - b)
    : [];
  const selectedWindows = useMemo(
    () =>
      selectedSlotKeys
        .map((key) => {
          const [dateStr, slotText] = key.split(":");
          const slotIndex = Number.parseInt(slotText ?? "", 10);
          if (!dateStr || !Number.isFinite(slotIndex)) return null;
          return {
            key,
            dateStr,
            slotIndex,
            start: localDateAtSlotStart(dateStr, slotIndex),
            hosts: slotHosts[key] ?? [],
            selectedAdminUserId: selectedHostBySlot[key] ?? "",
          };
        })
        .filter((window): window is { key: string; dateStr: string; slotIndex: number; start: Date; hosts: AdminAvailabilityHost[]; selectedAdminUserId: string } => Boolean(window))
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [selectedHostBySlot, selectedSlotKeys, slotHosts],
  );

  const canContinue = selectedWindows.length > 0 && selectedWindows.every((window) => window.hosts.length <= 1 || window.selectedAdminUserId);
  const daysInMonth = getDaysInMonth(calYear, calMonth);
  const firstDay = getFirstDayOfMonth(calYear, calMonth);

  const resetPickers = () => {
    setSelectedDay(null);
    setSelectedSlotKeys([]);
    setSelectedHostBySlot({});
  };

  const submit = () => {
    const n = name.trim();
    const em = email.trim();
    const errs: Record<string, string> = {};
    if (!n) errs.name = "Name is required.";
    if (!em) errs.email = "Email is required.";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      showToast("Please fix the highlighted fields before continuing.");
      queueMicrotask(() => scrollToFirstWizardFieldError(PARTNER_MEETING_STEP_FIELD_ORDER[2] ?? [], errs));
      return;
    }
    if (selectedWindows.length === 0) {
      showToast("Please go back and choose at least one time.");
      return;
    }
    const requestedWindows = selectedWindows.map((window) => {
      const end = new Date(window.start.getTime() + 30 * 60 * 1000);
      const host =
        window.hosts.find((candidate) => candidate.adminUserId === window.selectedAdminUserId) ??
        window.hosts[0];
      return {
        start: window.start.toISOString(),
        end: end.toISOString(),
        adminUserId: host?.adminUserId,
        adminLabel: host?.adminLabel,
      };
    });
    appendPartnerInquiry({
      name: n,
      email: em,
      phone: phone.trim(),
      notes: notes.trim(),
      requestedWindows,
      proposedStart: requestedWindows[0]!.start,
      proposedEnd: requestedWindows[0]!.end,
      adminUserId: requestedWindows[0]?.adminUserId,
      adminLabel: requestedWindows[0]?.adminLabel,
    });
    showToast("Request sent. Your proposed windows are now in the PropLane calendar.");
    setStep(1);
    setMaxStepReached(1);
    setName("");
    setEmail("");
    setPhone("");
    setNotes("");
    setFieldErrors({});
    resetPickers();
    bump();
  };

  const toggleSlot = (dateStr: string, slotIndex: number) => {
    const key = `${dateStr}:${slotIndex}`;
    const hosts = slotHosts[key] ?? [];
    setFieldErrors((prev) => {
      if (!prev.tourSlots) return prev;
      const next = { ...prev };
      delete next.tourSlots;
      return next;
    });
    setSelectedSlotKeys((current) => {
      if (current.includes(key)) {
        setSelectedHostBySlot((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return current.filter((item) => item !== key);
      }
      if (hosts.length === 1) {
        setSelectedHostBySlot((prev) => ({ ...prev, [key]: hosts[0]!.adminUserId }));
      }
      return [...current, key];
    });
  };

  const steps = [
    { n: 1 as const, label: "Date & time" },
    { n: 2 as const, label: "Your details" },
  ];

  return (
    <div className="mt-4 rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {steps.map((s, i) => {
          const reachable = canNavigateToWizardStep(s.n, maxStepReached);
          return (
          <div key={s.n} className="flex items-center gap-2">
            {i > 0 ? <div className="h-px w-4 bg-slate-200 sm:w-6" /> : null}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => {
                if (reachable) setStep(s.n);
              }}
              className={`flex items-center gap-2 ${reachable ? "" : "cursor-not-allowed opacity-45"}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                  step === s.n ? "bg-primary text-white" : s.n < step ? "bg-primary/20 text-primary" : "bg-accent/30 text-muted/70"
                }`}
              >
                {s.n}
              </span>
              <span className={`hidden sm:inline text-sm ${step === s.n ? "font-semibold text-foreground" : "text-muted/70"}`}>
                {s.label}
              </span>
            </button>
          </div>
        );
        })}
      </div>

      <div className="mt-6">
        {step === 1 ? (
          <div className="space-y-6">
            {!hasAnyPublished ? (
              <p className="rounded-2xl border px-4 py-3 text-sm portal-banner-pending">
                {loadingAvailability ? (
                  "Loading meeting windows..."
                ) : (
                  <>
                    No meeting windows are published yet. Availability can be set under{" "}
                    <span className="font-semibold">Admin portal - Events - Availability</span>. You can still use the
                    message tab to reach us.
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted">
                Pick one or more 30-minute windows that work for you. Only highlighted days and times match what
                your PropLane contact published in the admin portal.
              </p>
            )}

            <div
              data-wizard-field="tourSlots"
              className={wizardSectionErrorClass(Boolean(fieldErrors.tourSlots), "space-y-6")}
            >
            <div>
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    if (calMonth === 0) {
                      setCalMonth(11);
                      setCalYear((y) => y - 1);
                    } else setCalMonth((m) => m - 1);
                    resetPickers();
                  }}
                  className="rounded-full p-1.5 text-muted hover:bg-accent/30"
                  aria-label="Previous month"
                >
                  <ChevronLeftIcon />
                </button>
                <p className="text-sm font-semibold text-foreground">
                  {MONTHS[calMonth]} {calYear}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (calMonth === 11) {
                      setCalMonth(0);
                      setCalYear((y) => y + 1);
                    } else setCalMonth((m) => m + 1);
                    resetPickers();
                  }}
                  className="rounded-full p-1.5 text-muted hover:bg-accent/30"
                  aria-label="Next month"
                >
                  <ChevronRightIcon />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1">
                {DAYS.map((d) => (
                  <div key={d} className="py-1 text-center text-[11px] font-semibold uppercase text-muted/70">
                    {d}
                  </div>
                ))}
                {Array.from({ length: firstDay }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const ds = dateStrFromCalendar(calYear, calMonth, day);
                  const open = Object.keys(slotHosts).some((key) => key.startsWith(`${ds}:`) && (slotHosts[key]?.length ?? 0) > 0);
                  const isPast = isCalendarDayBeforeToday(calYear, calMonth, day);
                  const isSelected = selectedDay === day;
                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={!open || isPast}
                      onClick={() => {
                        setSelectedDay(day);
                      }}
                      className={`aspect-square rounded-xl text-sm font-medium transition-all ${
                        isSelected
                          ? "bg-primary text-white shadow-sm"
                          : open && !isPast
                            ? "bg-card text-foreground hover:bg-primary/[0.08] hover:text-primary"
                            : "cursor-not-allowed text-slate-300"
                      }`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedDay != null && selectedDateStr ? (
              <div>
                <p className="mb-3 text-sm font-semibold text-foreground">
                  Available times · {MONTHS[calMonth]} {selectedDay}
                </p>
                {openSlots.length === 0 ? (
                  <p className="text-sm text-muted">No open half-hour blocks on this day.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                    {openSlots.map((slotIndex) => {
                      const slotKey = `${selectedDateStr}:${slotIndex}`;
                      const isSelected = selectedSlotKeys.includes(slotKey);
                      return (
                      <button
                        key={slotIndex}
                        type="button"
                        onClick={() => toggleSlot(selectedDateStr, slotIndex)}
                        className={`rounded-xl border py-2.5 text-xs font-semibold transition-all ${
                          isSelected
                            ? "border-primary bg-primary text-white"
                            : "border-border bg-card text-foreground hover:border-primary hover:text-primary"
                        }`}
                      >
                        {formatAvailabilitySlotLabel(slotIndex)}
                      </button>
                    );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {selectedWindows.length > 0 ? (
              <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {selectedWindows.length} requested {selectedWindows.length === 1 ? "window" : "windows"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedSlotKeys([])}
                    className="text-xs font-semibold text-muted hover:text-foreground"
                  >
                    Clear all
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedWindows.map((window) => (
                    <div key={window.key} className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-3">
                      <button
                        type="button"
                        onClick={() => toggleSlot(window.dateStr, window.slotIndex)}
                        className="rounded-full bg-card px-3 py-1.5 text-xs font-semibold text-primary shadow-sm"
                      >
                        {window.start.toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        · {formatAvailabilitySlotLabel(window.slotIndex)} ×
                      </button>
                      {window.hosts.length > 1 ? (
                        <label className="mt-3 block text-xs font-semibold text-muted">
                          Choose admin
                          <Select
                           
                            value={window.selectedAdminUserId}
                            onChange={(e) => setSelectedHostBySlot((prev) => ({ ...prev, [window.key]: e.target.value }))}
                          >
                            <option value="">Select admin</option>
                            {window.hosts.map((host) => (
                              <option key={host.adminUserId} value={host.adminUserId}>
                                {host.adminLabel}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : window.hosts[0] ? (
                        <p className="mt-2 text-xs font-medium text-muted">With {window.hosts[0].adminLabel}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
                {!canContinue ? (
                  <p className="mt-3 text-xs font-semibold text-amber-700">
                    Pick an admin for each selected time with multiple admins available.
                  </p>
                ) : null}
              </div>
            ) : null}
            {fieldErrors.tourSlots ? (
              <p className="text-xs font-medium text-red-600">{fieldErrors.tourSlots}</p>
            ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {selectedWindows.length > 0 ? (
              <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm">
                <p className="font-semibold text-foreground">Requested windows</p>
                <div className="mt-2 space-y-1 text-muted">
                  {selectedWindows.map((window) => (
                    <p key={window.key}>
                      {window.start.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}{" "}
                      · {formatAvailabilitySlotLabel(window.slotIndex)}–{formatAvailabilitySlotLabel(window.slotIndex + 1)}
                      {window.hosts.length ? (
                        <> · {window.hosts.find((host) => host.adminUserId === window.selectedAdminUserId)?.adminLabel ?? window.hosts[0]!.adminLabel}</>
                      ) : null}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name *" fieldKey="name" error={fieldErrors.name}>
                <input
                  type="text"
                  placeholder="Jane Smith"
                  className={wizardFieldErrorClass(Boolean(fieldErrors.name), inputCls)}
                  value={name}
                  onChange={(e) => {
                    setFieldErrors((prev) => {
                      if (!prev.name) return prev;
                      const next = { ...prev };
                      delete next.name;
                      return next;
                    });
                    setName(e.target.value);
                  }}
                />
              </Field>
              <Field label="Email *" fieldKey="email" error={fieldErrors.email}>
                <input
                  type="email"
                  placeholder="jane@email.com"
                  className={wizardFieldErrorClass(Boolean(fieldErrors.email), inputCls)}
                  value={email}
                  onChange={(e) => {
                    setFieldErrors((prev) => {
                      if (!prev.email) return prev;
                      const next = { ...prev };
                      delete next.email;
                      return next;
                    });
                    setEmail(e.target.value);
                  }}
                />
              </Field>
            </div>
            <Field label="Phone" fieldKey="phone">
              <PhoneNumberField value={phone} onChange={setPhone} dataAttr="partner-meeting-phone" />
            </Field>
            <Field label="Notes (optional)">
              <textarea
                rows={3}
                placeholder="Anything we should prepare in advance?"
                className={`${inputCls} resize-none`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>

            <button
              type="button"
              onClick={submit}
              className="w-full rounded-2xl bg-[#0d1f4e] py-3.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-[#162d6e] active:scale-[0.98]"
            >
              Request meeting
            </button>
          </div>
        )}
      </div>

      <div className={`mt-6 flex ${step > 1 ? "justify-between" : "justify-end"}`}>
        {step > 1 ? (
          <button
            type="button"
            onClick={() => setStep(1)}
            className="rounded-full border border-border px-5 py-2 text-sm font-semibold text-muted hover:bg-accent/30"
          >
            Back
          </button>
        ) : null}
        {step < 2 ? (
          <button
            type="button"
            onClick={() => {
              const errs: Record<string, string> = {};
              if (selectedWindows.length === 0) {
                errs.tourSlots = "Select at least one meeting time.";
              } else if (!canContinue) {
                errs.tourSlots = "Pick an admin for each selected time with multiple admins available.";
              }
              if (Object.keys(errs).length > 0) {
                setFieldErrors(errs);
                showToast("Please fix the highlighted fields before continuing.");
                queueMicrotask(() => scrollToFirstWizardFieldError(PARTNER_MEETING_STEP_FIELD_ORDER[1] ?? [], errs));
                return;
              }
              setFieldErrors({});
              setStep(2);
              setMaxStepReached((m) => nextWizardMaxReached(m, 2) as Step);
            }}
            className="rounded-full bg-primary px-7 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-105"
          >
            Continue
          </button>
        ) : null}
      </div>
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
  children: React.ReactNode;
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
  "w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-foreground outline-none transition-all duration-150 placeholder:text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/15 hover:border-border";
