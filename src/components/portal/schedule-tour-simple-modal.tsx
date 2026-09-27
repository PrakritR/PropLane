"use client";

/**
 * N084 — "Schedule tour" simplified.
 *
 * Replaces the old 4-step `AddResidentWizard mode="tour"` (Guest → Home →
 * When → Review) with one screen: Property, Room, Date, an open-time-slot
 * picker, visitor name/phone/email, and a single Schedule button. Format and
 * Notes move behind a collapsed "More options", defaulted otherwise.
 *
 * Reuses the exact booking path the old wizard called — `buildProspectRow` +
 * `commitProspect` (`resident-wizard/state.ts` / `resident-wizard/commit.ts`),
 * which itself calls `createManualPlannedTourClient` → `POST
 * /api/portal/manual-tour`. No new endpoint, and the payload for equivalent
 * inputs is identical (`buildScheduleTourSimpleForm`,
 * `tests/unit/schedule-tour-simple.test.ts`).
 *
 * Open slots come ONLY from `fetchOpenTourSlotsForProperty`, the client half
 * of `listOpenTourSlots` — the one "what's open" function
 * (`docs/agents/tours-scheduling.md`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  WizardField,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { MoreOptions } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import type { PropertyOption } from "@/components/portal/resident-wizard/step-home";
import { useResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import { buildProspectRow, emptyAddPersonForm, thingsToFinish, type AddPersonForm } from "@/components/portal/resident-wizard/state";
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
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const [moreOpen, setMoreOpen] = useState(false);
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
    setMoreOpen(false);
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
  const noTour = form.tourFormat === "none";

  const todo = useMemo(() => {
    const base = thingsToFinish(form, "tour");
    if (!form.propertyId) base.push({ step: "home", label: "Property to show" });
    return base;
  }, [form]);

  const handleSchedule = useCallback(async () => {
    if (todo.length) {
      showToast(todo.map((t) => t.label).join(" · "));
      return;
    }
    const built = buildProspectRow(form, { userId: managerUserId, propertyLabelFor });
    if (!built.ok) {
      showToast(built.error);
      return;
    }
    const commitCtx: CommitContext = { userId: managerUserId, executedLeaseKeys: EMPTY_LEASE_KEYS, propertyLabelFor, assignee: null };
    const outcome = await commitProspect(built.row, form, commitCtx);
    if (outcome.failures.row) {
      showToast(outcome.failures.row);
      return;
    }
    if (outcome.failures.tour) {
      showToast(`Prospect added, but: ${outcome.failures.tour}`);
    }
    // Same tour-confirmed notice the old wizard's default (unedited) "Schedule
    // & send" sent — only when there is an actual tour time to confirm.
    if (!noTour && form.tourDate && form.tourStart && form.email.trim()) {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const listing = getPropertyById(form.propertyId);
      const start = new Date(`${form.tourDate}T${form.tourStart}:00`).toISOString();
      const durationMs = Math.max(15, Number(form.tourDurationMinutes) || 30) * 60000;
      const end = new Date(Date.parse(start) + durationMs).toISOString();
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
    }
    showToast(outcome.notes.length ? `Tour scheduled. ${outcome.notes.join(" · ")}.` : "Tour scheduled.");
    onAdded(outcome);
    onClose();
  }, [todo, form, managerUserId, propertyLabelFor, propertyLabel, noTour, showToast, onAdded, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule tour"
      description={propertyLabel ?? undefined}
      panelClassName="max-w-2xl"
      dataAttr="schedule-tour-simple-modal"
      footer={
        <ModalFooter>
          <Button variant="primary" onClick={handleSchedule} data-attr="schedule-tour-simple-submit">
            Schedule
          </Button>
        </ModalFooter>
      }
    >
      <WizardSection title="Property" dataAttr="schedule-tour-simple-home">
        <WizardRow cols={2}>
          <WizardSelect
            label="Property"
            value={form.propertyId}
            onChange={(next) => patch({ propertyId: next, roomId: "", bundleId: "" })}
            options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
            placeholder={propertyOptions.length ? "Select property…" : "No properties yet"}
            dataAttr="schedule-tour-simple-property"
          />
          {derived.showRoomSelect ? (
            <WizardSelect
              label="Room"
              value={form.roomId}
              onChange={(next) => patch({ roomId: next, bundleId: "" })}
              options={derived.roomOptions.map((r) => ({ value: r.id, label: r.name }))}
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

      {!noTour ? (
        <WizardSection title="Date & time" dataAttr="schedule-tour-simple-when">
          <WizardField label="Date" required>
            <Input
              type="date"
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
              Open times
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

      <WizardSection title="Visitor" dataAttr="schedule-tour-simple-visitor">
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
      </WizardSection>

      <MoreOptions
        label={`${form.tourFormat === "virtual" ? "Virtual" : form.tourFormat === "none" ? "No tour yet" : "In person"}${form.tourNotes.trim() ? " · notes added" : ""}`}
        open={moreOpen}
        onToggle={() => setMoreOpen((v) => !v)}
        dataAttr="schedule-tour-simple-more-options"
      >
        <WizardRow cols={1}>
          <WizardSelect
            label="Format"
            value={form.tourFormat}
            onChange={(next) => patch({ tourFormat: next === "virtual" ? "virtual" : next === "none" ? "none" : "in_person" })}
            options={[
              { value: "in_person", label: "In person", hint: "at the property" },
              { value: "virtual", label: "Virtual", hint: "video link sent with the confirmation" },
              { value: "none", label: "No tour yet", hint: "just keep them in Potential" },
            ]}
            dataAttr="schedule-tour-simple-format"
          />
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
      </MoreOptions>
    </Modal>
  );
}
