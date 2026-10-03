"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { AddWorkspace } from "@/components/portal/add-workspace";
import { isoWindowFromSlotKey, slotKeyForInstant } from "@/lib/tour-slot-math";
import { Input, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  WizardField,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import type { PropertyOption } from "@/components/portal/resident-wizard/step-home";
import { useResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import { buildProspectRow, emptyAddPersonForm, type AddPersonForm } from "@/components/portal/resident-wizard/state";
import { commitProspect, sendClosingMessage, type CommitContext, type CommitOutcome } from "@/components/portal/resident-wizard/commit";
import { getPropertyById } from "@/lib/rental-application/data";
import { TOUR_CONFIRMED_TENANT_SUBJECT, buildTourConfirmedTenantBody, buildTourNotificationContext } from "@/lib/tour-notifications";
import {
  fetchOpenTourSlotsForProperty,
  openSlotKeysForDate,
  slotKeyToTourFields,
  type SlotHosts,
} from "@/lib/schedule-tour-simple";
import { formatAvailabilitySlotLabel } from "@/lib/demo-admin-scheduling";
import { cn } from "@/lib/utils";

const EMPTY_LEASE_KEYS = { axisIds: new Set<string>(), emails: new Set<string>() };

function todayLocalDateStr(): string {
  return slotKeyForInstant(new Date().toISOString())?.split(":")[0] ?? "";
}

export function ScheduleTourSimpleModal({
  open,
  onClose,
  managerUserId,
  propertyOptions,
  propertyTick,
  defaultPropertyId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
  propertyOptions: PropertyOption[];
  propertyTick: number;
  defaultPropertyId?: string;
  onAdded: (outcome: CommitOutcome) => void;
}) {
  const { showToast } = useAppUi();
  const [form, setForm] = useState<AddPersonForm>(() => ({
    ...emptyAddPersonForm("prospect"),
    propertyId: defaultPropertyId ?? "",
  }));
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const savedVisitor = useRef<CommitOutcome["row"] | null>(null);
  const [selectedDateStr, setSelectedDateStr] = useState(() => todayLocalDateStr());
  const [slotKey, setSlotKey] = useState<string | null>(null);
  const [slotHosts, setSlotHosts] = useState<SlotHosts>({});
  const [availability, setAvailability] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    setForm({ ...emptyAddPersonForm("prospect"), propertyId: defaultPropertyId ?? "" });
    setSlotKey(null);
    setSelectedDateStr(todayLocalDateStr());
    setSlotHosts({});
    setCurrent(0);
    setError("");
    savedVisitor.current = null;
  }, [open, defaultPropertyId]);

  const patch = useCallback((next: Partial<AddPersonForm>) => setForm((prev) => ({ ...prev, ...next })), []);
  const derived = useResidentWizardDerived(form, propertyTick, patch);

  useEffect(() => {
    if (!open || !form.propertyId) {
      setSlotHosts({});
      setAvailability("idle");
      return;
    }
    let cancelled = false;
    const listing = getPropertyById(form.propertyId);
    setAvailability("loading");
    void fetchOpenTourSlotsForProperty({ id: form.propertyId, buildingName: listing?.buildingName, address: listing?.address }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setSlotHosts({});
        setAvailability("error");
        return;
      }
      setSlotHosts(result.slotHosts);
      setAvailability("idle");
    });
    return () => {
      cancelled = true;
    };
  }, [open, form.propertyId]);

  const daySlotKeys = useMemo(() => openSlotKeysForDate(slotHosts, selectedDateStr), [slotHosts, selectedDateStr]);

  const pickSlot = useCallback(
    (key: string) => {
      const fields = slotKeyToTourFields(key);
      if (!fields) return;
      setSlotKey(key);
      patch({ tourDate: fields.tourDate, tourStart: fields.tourStart });
    },
    [patch],
  );

  const propertyLabelFor = useCallback((id: string) => propertyOptions.find((p) => p.id === id)?.label, [propertyOptions]);
  const propertyLabel = propertyLabelFor(form.propertyId);
  const issues = [
    !form.propertyId ? "Choose a property." : "",
    availability !== "idle" || !slotKey || !slotHosts[slotKey]?.length ? "Choose an open time." : "",
    !form.name.trim() ? "Enter the visitor's name." : form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) ? "Enter a valid email address." : form.phone.trim() && !/^\+?[\d ().-]+$/.test(form.phone.trim()) || (form.phone.trim() && (form.phone.replace(/\D/g, "").length < 10 || form.phone.replace(/\D/g, "").length > 15)) ? "Enter a valid phone number." : "",
  ];
  const steps = ["Home", "Date & time", "Visitor", "Review"].map((label, index) => ({ id: String(index), label, incomplete: Boolean(issues[index]) }));
  const jump = (next: number) => {
    const invalid = issues.findIndex((issue, index) => index < next && Boolean(issue));
    if (next > current && invalid >= 0) { setError(issues[invalid]); setCurrent(invalid); return; }
    setError(""); setCurrent(next);
  };

  const handleSchedule = async () => {
    const problem = issues.find(Boolean);
    if (problem || !managerUserId) { setError(problem || "Sign in to add a tour."); return; }
    setBusy(true);
    setError("");
    try {
    const fresh = await fetchOpenTourSlotsForProperty({ id: form.propertyId });
    const window = slotKey ? isoWindowFromSlotKey(slotKey) : null;
    if (!fresh.ok || !slotKey || !fresh.slotHosts[slotKey]?.length || !window || Date.parse(window.start) <= Date.now()) {
      setSlotKey(null); setCurrent(1); setError(fresh.ok ? "That time is no longer open. Choose another time." : fresh.error);
      if (fresh.ok) setSlotHosts(fresh.slotHosts);
      return;
    }
    const built = buildProspectRow(form, { userId: managerUserId, propertyLabelFor, allowContactless: true });
    if (!built.ok) {
      showToast(built.error);
      return;
    }
    const commitCtx: CommitContext = { userId: managerUserId, executedLeaseKeys: EMPTY_LEASE_KEYS, propertyLabelFor, assignee: null, tourWindow: window };
    const outcome = await commitProspect(savedVisitor.current ?? built.row, form, commitCtx);
    if (outcome.failures.row) {
      showToast(outcome.failures.row);
      return;
    }
    savedVisitor.current = outcome.row;
    if (outcome.failures.tour || !outcome.tourId) {
      setError(`Visitor saved. ${outcome.failures.tour ?? "Could not confirm the tour."}`);
      return;
    }
    // Same tour-confirmed notice the old wizard's default (unedited) "Schedule
    // & send" sent — only when there is an actual tour time to confirm.
    if (form.email.trim()) {
      try {
      const origin = globalThis.location?.origin ?? "";
      const listing = getPropertyById(form.propertyId);
      const { start, end } = window;
      const notifyCtx = buildTourNotificationContext({
        origin,
        guestName: form.name.trim(),
        guestEmail: form.email.trim(),
        guestPhone: form.phone.trim() || null,
        propertyId: form.propertyId,
        propertyTitle: propertyLabel ?? listing?.title ?? "the property",
        propertyAddress: listing?.address ?? null,
        roomLabel: built.row.manualResidentDetails?.roomNumber ?? null,
        tourFormat: form.tourFormat === "virtual" ? "virtual" : "in_person",
        tourStartIso: start,
        tourEndIso: end,
        notes: form.tourNotes.trim() || null,
        managerLabel: "Property Manager",
      });
      const sent = await sendClosingMessage({
        toEmail: form.email.trim(),
        viaEmail: true,
        viaSms: false,
        subject: TOUR_CONFIRMED_TENANT_SUBJECT,
        body: buildTourConfirmedTenantBody(notifyCtx),
        recipientName: form.name.trim(),
      });
      if (!sent.ok) showToast(`Tour scheduled, but: ${sent.message}`);
      } catch { showToast("Tour scheduled, but the confirmation could not be sent."); }
    }
    showToast(outcome.notes.length ? `Tour scheduled. ${outcome.notes.join(" · ")}.` : "Tour scheduled.");
    onAdded(outcome);
    onClose();
    } catch { setError("Could not add the tour. Try again."); }
    finally { setBusy(false); }
  };

  const facts = [["Property", propertyLabel], ["Room", derived.roomOptions.find((room) => room.id === form.roomId)?.name ?? "Any room"], ["Format", form.tourFormat === "virtual" ? "Virtual" : "In person"], ["Date & time", slotKey ? `${form.tourDate} · ${form.tourStart} Pacific` : ""], ["Visitor", form.name], ["Email", form.email], ["Phone", form.phone], ["Notes", form.tourNotes]];
  const review = <dl className="divide-y divide-border rounded-2xl border border-border bg-card px-5">{facts.map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-4 text-sm"><dt className="text-muted">{label}</dt><dd className="min-w-0 break-words text-right font-semibold">{value || "Not set"}</dd></div>)}</dl>;
  if (!open) return null;
  return (
    <AddWorkspace title="Add tour" steps={steps} current={current} onJump={jump} onClose={onClose}
      dirty={Boolean(form.propertyId || form.name)} assistantContext="Add tour" assistantScopeKey="schedule-tour-wizard"
      lastLabel="Add tour" busy={busy} onFinish={handleSchedule} onBeforeNext={() => { if (issues[current]) { setError(issues[current]); return false; } return true; }}
      finishCount={issues.filter(Boolean).length} dataAttrPrefix="schedule-tour-simple" finishDataAttr="schedule-tour-simple-submit"
      railHeader={<div className="rounded-2xl border border-dashed border-border p-6 text-center font-semibold">Contact and tour</div>}
      sidePanel={<aside><h3 className="mb-3 text-xs font-bold uppercase tracking-wide">Tour preview</h3>{review}</aside>}
    >
      {error ? <p role="alert" className="mb-4 text-sm text-danger">{error}</p> : null}
      {current === 0 ? <>
      <WizardSection title="Property" dataAttr="schedule-tour-simple-home">
        <WizardRow cols={2}>
          <WizardSelect
            label="Property"
            value={form.propertyId}
            onChange={(next) => { setSlotKey(null); setSlotHosts({}); patch({ propertyId: next, roomId: "", bundleId: "", tourDate: "", tourStart: "" }); }}
            options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
            placeholder={propertyOptions.length ? "Select property…" : "No properties yet"}
            dataAttr="schedule-tour-simple-property"
          />
          {derived.showRoomSelect ? (
            <WizardSelect
              label="Room"
              value={form.roomId}
              onChange={(next) => patch({ roomId: next, bundleId: "" })}
              options={[{ value: "", label: "Any room" }, ...derived.roomOptions.map((r) => ({ value: r.id, label: r.name }))]}
              placeholder="Select room…"
              dataAttr="schedule-tour-simple-room"
            />
          ) : derived.showBundleSelect ? (
            <WizardSelect
              label="Lease bundle"
              value={form.bundleId}
              onChange={(next) => patch({ bundleId: next, roomId: next ? "" : form.roomId })}
              options={[{ value: "", label: "None: the whole place" }, ...derived.bundleOptions]}
              dataAttr="schedule-tour-simple-bundle"
            />
          ) : null}
        </WizardRow>
      </WizardSection>

      <WizardSelect label="Format" value={form.tourFormat} onChange={(next) => patch({ tourFormat: next === "virtual" ? "virtual" : "in_person" })} options={[{ value: "in_person", label: "In person" }, { value: "virtual", label: "Virtual" }]} dataAttr="schedule-tour-simple-format" />
      </> : null}
      {current === 1 ? (
        <WizardSection title="Date & time" dataAttr="schedule-tour-simple-when">
          <WizardField label="Date" required>
            <Input
              type="date"
              min={todayLocalDateStr()}
              className="portal-modal-date-input"
              value={selectedDateStr}
              onChange={(e) => {
                setSelectedDateStr(e.target.value);
                setSlotKey(null);
                patch({ tourDate: "", tourStart: "" });
              }}
              data-attr="schedule-tour-simple-date"
            />
          </WizardField>
          <div className="mt-3">
            <span className="mb-1.5 block text-[12.5px] font-bold text-foreground">
              Open times · Pacific time
              <span className="text-red-600">*</span>
            </span>
            {!form.propertyId ? (
              <p className="text-sm text-muted">Pick a property to see open times.</p>
            ) : availability === "loading" ? (
              <p className="text-sm text-muted">Loading open times…</p>
            ) : availability === "error" ? (
              <p className="text-sm text-muted">Could not load open tour times.</p>
            ) : daySlotKeys.length === 0 ? (
              <p className="text-sm text-muted">No open times this day — try another date.</p>
            ) : (
              <div className="flex flex-wrap gap-2" data-attr="schedule-tour-simple-slots">
                {daySlotKeys.map((key) => {
                  const idx = Number.parseInt(key.split(":")[1] ?? "", 10);
                  const selected = key === slotKey;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => pickSlot(key)}
                      data-attr="schedule-tour-simple-slot"
                      aria-pressed={selected}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[13px] font-semibold transition",
                        selected
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-card text-foreground hover:border-primary/50",
                      )}
                    >
                      {formatAvailabilitySlotLabel(idx)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </WizardSection>
      ) : null}

      {current === 2 ? <WizardSection title="Visitor" dataAttr="schedule-tour-simple-visitor">
        <WizardRow cols={3}>
          <WizardField label="Name" required>
            <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Jane Smith" data-attr="schedule-tour-simple-name" />
          </WizardField>
          <WizardField label="Phone">
            <PhoneNumberField value={form.phone} onChange={(next) => patch({ phone: next })} dataAttr="schedule-tour-simple-phone" />
          </WizardField>
          <WizardField label="Email">
            <Input type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="jane@example.com" data-attr="schedule-tour-simple-email" />
          </WizardField>
        </WizardRow>
        <div className="mt-3">
          <WizardField label="Notes for the tour">
            <Textarea
              className="min-h-[72px]"
              value={form.tourNotes}
              onChange={(e) => patch({ tourNotes: e.target.value })}
              placeholder="Parking, which key, who to meet…"
              data-attr="schedule-tour-simple-notes"
            />
          </WizardField>
        </div>
      </WizardSection> : null}
      {current === 3 ? <WizardSection title="Review">{review}</WizardSection> : null}
    </AddWorkspace>
  );
}
