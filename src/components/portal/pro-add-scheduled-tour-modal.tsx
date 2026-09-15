"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  Modal,
  ModalFooter,
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
import { PORTAL_MODAL_BODY_SCROLL_CLASS } from "@/components/ui/modal-styles";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import { createManualPlannedTourClient } from "@/lib/manual-planned-tour.client";
import { DEFAULT_TOUR_FORMAT, TOUR_FORMAT_OPTIONS, normalizeTourFormat, type TourFormat } from "@/lib/tour-format";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForTour,
} from "@/lib/manager-scheduled-work-tasks";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";
import type { WorkAssignee } from "@/lib/work-assignment";
import { cn } from "@/lib/utils";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  TOUR_CONFIRMED_TENANT_SUBJECT,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
} from "@/lib/tour-notifications";
import { getPropertyById } from "@/lib/rental-application/data";

/** After the tour is saved: the guest message the manager reviews before it goes out. */
type GuestPreview = {
  guestName: string;
  email: string;
  phone?: string;
  subject: string;
  body: string;
};

const DURATION_OPTIONS = [
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
];

function combineLocalDateTime(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(h) || Number.isNaN(min)) {
    throw new Error("Choose a valid date and time.");
  }
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function roomNameFromOptionLabel(label: string): string {
  return label.split(" · ")[0]?.trim() || label.trim();
}

function defaultScheduleFields(): { scheduleDate: string; startTime: string } {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const hour = d.getHours();
  if (hour >= 17 || hour < 9) {
    if (hour >= 17) {
      d.setDate(d.getDate() + 1);
    }
    d.setHours(10, 0, 0, 0);
  }
  return {
    scheduleDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    startTime: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

const EMPTY_FORM = {
  propertyId: "",
  guestName: "",
  guestEmail: "",
  guestPhone: "",
  scheduleDate: "",
  startTime: "",
  durationMinutes: "60",
  tourFormat: DEFAULT_TOUR_FORMAT as TourFormat,
  notes: "",
};

export function ManagerAddScheduledTourModal({
  open,
  onClose,
  managerUserId,
  propertyTick = 0,
  defaultPropertyId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string;
  propertyTick?: number;
  /** Property detail tours tab — pre-select this listing. */
  defaultPropertyId?: string;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const [saving, setSaving] = useState(false);
  const [guestPreview, setGuestPreview] = useState<GuestPreview | null>(null);
  const [guestPreviewBusy, setGuestPreviewBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [selectedRoomValue, setSelectedRoomValue] = useState("");

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(managerUserId),
    [managerUserId, propertyTick],
  );

  const roomOptions = useMemo(() => {
    if (!form.propertyId) return [];
    return getRoomOptionsForProperty(form.propertyId, { includeUnavailable: true }).filter((option) => option.value);
  }, [form.propertyId]);

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM);
      setAssignee(null);
      setSelectedRoomValue("");
      return;
    }
    setForm({
      ...EMPTY_FORM,
      ...defaultScheduleFields(),
      propertyId: defaultPropertyId ?? "",
    });
  }, [defaultPropertyId, open]);

  async function handleSave() {
    if (!form.propertyId) {
      showToast("Pick a property.");
      return;
    }
    if (!form.guestName.trim()) {
      showToast("Guest name is required.");
      return;
    }
    if (!form.scheduleDate || !form.startTime) {
      showToast("Pick a date and start time.");
      return;
    }

    setSaving(true);
    try {
      const start = combineLocalDateTime(form.scheduleDate, form.startTime);
      const durationMs = Math.max(15, Number(form.durationMinutes) || 60) * 60 * 1000;
      const end = new Date(Date.parse(start) + durationMs).toISOString();
      const property = propertyOptions.find((option) => option.id === form.propertyId);
      const roomOption = roomOptions.find((option) => option.value === selectedRoomValue);
      const roomLabel = roomOption ? roomNameFromOptionLabel(roomOption.label) : undefined;

      const result = await createManualPlannedTourClient(managerUserId, {
        propertyId: form.propertyId,
        propertyTitle: compactTaskPropertyLabel(form.propertyId, property?.label) ?? property?.label,
        roomLabel,
        guestName: form.guestName.trim(),
        guestEmail: form.guestEmail.trim() || undefined,
        guestPhone: form.guestPhone.trim() || undefined,
        start,
        end,
        notes: form.notes.trim() || undefined,
        tourFormat: form.tourFormat,
        assignee,
      });

      if (!result.ok) {
        showToast(result.error);
        return;
      }

      if (assignee) {
        void createScheduledWorkTask(managerUserId, {
          title: scheduledTaskTitleForTour(form.guestName.trim()),
          start,
          end,
          propertyId: form.propertyId,
          propertyTitle: property?.label,
          roomLabel,
          assignee,
          taskType: "tour",
          linkedTourId: String(result.plannedEvent?.id ?? ""),
          notes: form.guestEmail.trim() ? `Guest: ${form.guestEmail.trim()}` : undefined,
        });
      }

      showToast(result.message);

      // The next screen is the message the guest will get — the same preview
      // tours use for confirm / reschedule — as long as there is somewhere to
      // send it. A guest with no email and no phone just saves. `onSaved` is
      // deferred until the preview is done: the tours page answers it by
      // navigating to Upcoming, which would unmount this modal mid-preview.
      const guestEmail = form.guestEmail.trim();
      const guestPhone = form.guestPhone.trim();
      if (guestEmail.includes("@") || guestPhone) {
        const listing = getPropertyById(form.propertyId);
        const ctx = buildTourNotificationContext({
          origin: typeof window !== "undefined" ? window.location.origin : "",
          guestName: form.guestName.trim(),
          guestEmail,
          guestPhone: guestPhone || null,
          propertyId: form.propertyId,
          propertyTitle: property?.label ?? listing?.title ?? "Property",
          propertyAddress: listing?.address ?? null,
          roomLabel: roomLabel ?? null,
          tourFormat: form.tourFormat,
          tourStartIso: start,
          tourEndIso: end,
          notes: form.notes.trim() || null,
          managerLabel: "Property Manager",
        });
        setGuestPreview({
          guestName: form.guestName.trim(),
          email: guestEmail,
          phone: guestPhone || undefined,
          subject: TOUR_CONFIRMED_TENANT_SUBJECT,
          body: buildTourConfirmedTenantBody(ctx),
        });
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not schedule tour.");
    } finally {
      setSaving(false);
    }
  }

  const sendGuestPreview = async (
    skip: boolean,
    channels?: { viaEmail: boolean; viaSms: boolean },
    draft?: { subject: string; body: string },
  ) => {
    if (!guestPreview || guestPreviewBusy) return;
    if (skip) {
      setGuestPreview(null);
      onSaved?.();
      onClose();
      return;
    }
    setGuestPreviewBusy(true);
    try {
      const result = await deliverPortalInboxMessage({
        eventCategory: "messages",
        fromName: "Property Manager",
        toEmails: guestPreview.email.includes("@") ? [guestPreview.email] : [],
        subject: draft?.subject?.trim() || guestPreview.subject,
        text: draft?.body?.trim() || guestPreview.body,
        deliverViaEmail: channels?.viaEmail ?? guestPreview.email.includes("@"),
        deliverViaSms: (channels?.viaSms ?? false) && Boolean(guestPreview.phone),
      });
      if (!result.ok) {
        showToast(result.error ?? "Message could not be sent.");
        return;
      }
      showToast(`Sent to ${guestPreview.guestName || "the guest"}.`);
      setGuestPreview(null);
      onSaved?.();
      onClose();
    } finally {
      setGuestPreviewBusy(false);
    }
  };

  return (
    <>
    {guestPreview ? (
      <PortalNotificationPreviewModal
        open
        title={`Message ${guestPreview.guestName || "guest"}`}
        onClose={() => {
          if (guestPreviewBusy) return;
          setGuestPreview(null);
          onSaved?.();
          onClose();
        }}
        recipient={guestPreview.email || guestPreview.phone || ""}
        recipientPhone={guestPreview.phone}
        subject={guestPreview.subject}
        body={guestPreview.body}
        editableSubject
        editableBody
        skipMessageLabel="Skip message"
        showChannelPicker
        emailAvailable={guestPreview.email.includes("@")}
        smsAvailable={Boolean(guestPreview.phone)}
        defaultViaSms={false}
        confirmLabel="Send"
        confirmBusy={guestPreviewBusy}
        confirmBusyLabel="Sending…"
        onConfirm={(skip, channels, draft) => void sendGuestPreview(skip, channels, draft)}
      />
    ) : null}
    <Modal open={open && !guestPreview} onClose={onClose} title="Schedule tour" dense assistantContext="Schedule tour" footer={
      <ModalFooter>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !form.propertyId || !form.guestName.trim()}
          data-attr="manual-tour-save"
        >
          {saving ? "Scheduling…" : "Schedule tour"}
        </Button>
      </ModalFooter>
    }>
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
      <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-property">
            Property
          </label>
          <Select
            id="manual-tour-property"
            value={form.propertyId}
            onChange={(e) => {
              setForm((current) => ({ ...current, propertyId: e.target.value }));
              setSelectedRoomValue("");
            }}
            data-attr="manual-tour-property"
          >
            <option value="">Select property</option>
            {propertyOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        {form.propertyId ? (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-room">
              Room (optional)
            </label>
            <Select
              id="manual-tour-room"
              value={selectedRoomValue}
              onChange={(e) => setSelectedRoomValue(e.target.value)}
              data-attr="manual-tour-room"
            >
              <option value="">No room</option>
              {roomOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-guest-name">
            Guest name
          </label>
          <Input
            id="manual-tour-guest-name"
            value={form.guestName}
            onChange={(e) => setForm((current) => ({ ...current, guestName: e.target.value }))}
            placeholder="Jane Smith"
            data-attr="manual-tour-guest-name"
          />
        </div>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-guest-email">
            Guest email (optional)
          </label>
          <Input
            id="manual-tour-guest-email"
            type="email"
            value={form.guestEmail}
            onChange={(e) => setForm((current) => ({ ...current, guestEmail: e.target.value }))}
            placeholder="jane@example.com"
            data-attr="manual-tour-guest-email"
          />
        </div>
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-guest-phone">
            Guest phone (optional)
          </label>
          <PhoneNumberField
            id="manual-tour-guest-phone"
            value={form.guestPhone}
            onChange={(guestPhone) => setForm((current) => ({ ...current, guestPhone }))}
            dataAttr="manual-tour-guest-phone"
          />
        </div>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-date">
            Date
          </label>
          <Input
            id="manual-tour-date"
            type="date"
            value={form.scheduleDate}
            onChange={(e) => setForm((current) => ({ ...current, scheduleDate: e.target.value }))}
            data-attr="manual-tour-date"
          />
        </div>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-start-time">
            Start time
          </label>
          <Input
            id="manual-tour-start-time"
            type="time"
            value={form.startTime}
            onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))}
            data-attr="manual-tour-start-time"
          />
        </div>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-duration">
            Duration
          </label>
          <Select
            id="manual-tour-duration"
            value={form.durationMinutes}
            onChange={(e) => setForm((current) => ({ ...current, durationMinutes: e.target.value }))}
            data-attr="manual-tour-duration"
          >
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-format">
            Tour format
          </label>
          <Select
            id="manual-tour-format"
            value={form.tourFormat}
            onChange={(e) =>
              setForm((current) => ({ ...current, tourFormat: normalizeTourFormat(e.target.value) }))
            }
            data-attr="manual-tour-format"
          >
            {TOUR_FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <WorkAssignmentPicker
            kind="tour"
            value={assignee}
            teamMembers={teamMembers}
            vendors={vendors}
            disabled={saving}
            label="Assignee (optional)"
            dataAttr="manual-tour-assignee"
            onChange={setAssignee}
          />
        </div>
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manual-tour-notes">
            Notes (optional)
          </label>
          <textarea
            id="manual-tour-notes"
            className="min-h-[5rem] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
            value={form.notes}
            onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
            data-attr="manual-tour-notes"
          />
        </div>
      </div>
      </div>
    </Modal>
    </>
  );
}
