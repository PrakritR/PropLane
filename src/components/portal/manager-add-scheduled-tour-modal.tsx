"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import { createManualPlannedTourClient } from "@/lib/manual-planned-tour.client";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForTour,
} from "@/lib/manager-scheduled-work-tasks";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";
import type { WorkAssignee } from "@/lib/work-assignment";

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

function defaultScheduleDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultStartTime(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  if (d.getHours() >= 17) {
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const EMPTY_FORM = {
  propertyId: "",
  guestName: "",
  guestEmail: "",
  guestPhone: "",
  scheduleDate: "",
  startTime: "",
  durationMinutes: "60",
  notes: "",
};

export function ManagerAddScheduledTourModal({
  open,
  onClose,
  managerUserId,
  propertyTick = 0,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string;
  propertyTick?: number;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const [saving, setSaving] = useState(false);
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
      scheduleDate: defaultScheduleDate(),
      startTime: defaultStartTime(),
    });
  }, [open]);

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
          notes: form.guestEmail.trim() ? `Guest: ${form.guestEmail.trim()}` : undefined,
        });
      }

      onClose();
      onSaved?.();
      showToast(result.message);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not schedule tour.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Schedule tour" dense assistantStrip={false}>
      <div className="space-y-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Property</span>
          <Select
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
        </label>
        {form.propertyId ? (
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Room (optional)</span>
            <Select
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
          </label>
        ) : null}
        <Input
          aria-label="Guest name"
          value={form.guestName}
          onChange={(e) => setForm((current) => ({ ...current, guestName: e.target.value }))}
          placeholder="Guest name"
          data-attr="manual-tour-guest-name"
        />
        <Input
          aria-label="Guest email"
          type="email"
          value={form.guestEmail}
          onChange={(e) => setForm((current) => ({ ...current, guestEmail: e.target.value }))}
          placeholder="Guest email (optional)"
          data-attr="manual-tour-guest-email"
        />
        <Input
          aria-label="Guest phone"
          type="tel"
          value={form.guestPhone}
          onChange={(e) => setForm((current) => ({ ...current, guestPhone: e.target.value }))}
          placeholder="Guest phone (optional)"
          data-attr="manual-tour-guest-phone"
        />
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Date</span>
          <Input
            type="date"
            value={form.scheduleDate}
            onChange={(e) => setForm((current) => ({ ...current, scheduleDate: e.target.value }))}
            data-attr="manual-tour-date"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Start time</span>
            <Input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))}
              data-attr="manual-tour-start-time"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Duration</span>
            <Select
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
          </label>
        </div>
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
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Notes (optional)</span>
          <textarea
            className="min-h-[72px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
            value={form.notes}
            onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
            data-attr="manual-tour-notes"
          />
        </label>
      </div>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !form.propertyId || !form.guestName.trim()}
          data-attr="manual-tour-save"
        >
          {saving ? "Scheduling…" : "Schedule tour"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
