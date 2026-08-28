"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import {
  createManagerTask,
  fetchManagerTasks,
  reapplyManagerTasksToCalendar,
  updateManagerTask,
} from "@/lib/manager-tasks";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";
import type { WorkAssignee } from "@/lib/work-assignment";

function combineLocalDateTime(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(h) || Number.isNaN(min)) {
    throw new Error("Choose a valid date and time.");
  }
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function localDatePart(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimePart(iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function roomNameFromOptionLabel(label: string): string {
  return label.split(" · ")[0]?.trim() || label.trim();
}

const EMPTY_FORM = {
  title: "",
  notes: "",
  propertyId: "",
  roomLabel: "",
  scheduleDate: "",
  dueDate: "",
  startTime: "",
  endTime: "",
};

export function ManagerTaskFormModal({
  open,
  onClose,
  managerUserId,
  editingId,
  propertyTick = 0,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string;
  editingId?: string | null;
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
    if (!editingId && teamMembers.length > 0) {
      const self = teamMembers.find((m) => m.userId === managerUserId) ?? teamMembers[0];
      if (self) {
        setAssignee({
          type: "team",
          id: self.userId,
          name: self.name?.trim() || self.email?.trim() || "You",
        });
      }
    }
    if (!editingId) return;
    let cancelled = false;
    void fetchManagerTasks(managerUserId).then((tasks) => {
      if (cancelled) return;
      const task = tasks.find((row) => row.id === editingId);
      if (!task) return;
      setForm({
        title: task.title,
        notes: task.notes ?? "",
        propertyId: task.propertyId ?? "",
        roomLabel: task.roomLabel ?? "",
        scheduleDate: localDatePart(task.start),
        dueDate: localDatePart(task.dueDate),
        startTime: localTimePart(task.start),
        endTime: localTimePart(task.end),
      });
      setAssignee(task.assignee ?? null);
      const match = getRoomOptionsForProperty(task.propertyId ?? "", { includeUnavailable: true }).find(
        (option) => roomNameFromOptionLabel(option.label) === (task.roomLabel?.split(" · ")[0]?.trim() ?? task.roomLabel),
      );
      setSelectedRoomValue(match?.value ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [open, editingId, managerUserId, teamMembers]);

  async function handleSave() {
    if (!assignee) {
      showToast("Choose who this task is assigned to.");
      return;
    }
    setSaving(true);
    try {
      const start =
        form.scheduleDate && form.startTime
          ? combineLocalDateTime(form.scheduleDate, form.startTime)
          : undefined;
      const end =
        form.scheduleDate && form.endTime ? combineLocalDateTime(form.scheduleDate, form.endTime) : undefined;
      const dueDate =
        !start && !end && form.dueDate
          ? combineLocalDateTime(form.dueDate, "23:59")
          : undefined;
      const property = propertyOptions.find((option) => option.id === form.propertyId);
      const roomOption = roomOptions.find((option) => option.value === selectedRoomValue);
      const roomLabel = roomOption
        ? roomNameFromOptionLabel(roomOption.label)
        : form.roomLabel.trim() || undefined;
      const cleared = editingId ? "" : undefined;
      const input = {
        title: form.title,
        notes: form.notes,
        propertyId: form.propertyId || cleared,
        propertyTitle: form.propertyId
          ? compactTaskPropertyLabel(form.propertyId, property?.label) ?? property?.label
          : cleared,
        roomLabel: roomLabel || cleared,
        start: start ?? cleared,
        end: end ?? cleared,
        dueDate: dueDate ?? (editingId && !start && !end ? cleared : undefined),
        assignee,
      };
      if (editingId) {
        await updateManagerTask(managerUserId, editingId, input);
      } else {
        await createManagerTask(managerUserId, input);
      }
      reapplyManagerTasksToCalendar(managerUserId);
      onClose();
      onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingId ? "Edit task" : "Add task"}
      dense
      assistantStrip={false}
    >
      <div className="space-y-3">
        <Input
          aria-label="Task title"
          value={form.title}
          onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))}
          placeholder="Inspect unit, meet vendor, follow up…"
          data-attr="manager-task-title-input"
        />
        <WorkAssignmentPicker
          kind="task"
          value={assignee}
          teamMembers={teamMembers}
          vendors={vendors}
          disabled={saving}
          label="Assignee"
          dataAttr="manager-task-assignee"
          onChange={setAssignee}
        />
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Property (optional)</span>
          <Select
            value={form.propertyId}
            onChange={(e) => {
              setForm((current) => ({
                ...current,
                propertyId: e.target.value,
                roomLabel: "",
              }));
              setSelectedRoomValue("");
            }}
          >
            <option value="">No property</option>
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
              onChange={(e) => {
                const value = e.target.value;
                setSelectedRoomValue(value);
                const option = roomOptions.find((row) => row.value === value);
                setForm((current) => ({
                  ...current,
                  roomLabel: option ? roomNameFromOptionLabel(option.label) : "",
                }));
              }}
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
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Schedule date (optional)</span>
          <Input
            type="date"
            value={form.scheduleDate}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                scheduleDate: e.target.value,
                dueDate: e.target.value ? "" : current.dueDate,
              }))
            }
          />
        </label>
        {!form.scheduleDate ? (
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Due date</span>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((current) => ({ ...current, dueDate: e.target.value }))}
              data-attr="manager-task-due-date"
            />
          </label>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Start time (optional)</span>
            <Input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))}
              disabled={!form.scheduleDate}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">End time (optional)</span>
            <Input
              type="time"
              value={form.endTime}
              onChange={(e) => setForm((current) => ({ ...current, endTime: e.target.value }))}
              disabled={!form.scheduleDate}
            />
          </label>
        </div>
        <label className="space-y-1 text-sm">
          <span className="font-medium text-foreground">Notes (optional)</span>
          <textarea
            className="min-h-[80px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
            value={form.notes}
            onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
          />
        </label>
        <p className="text-xs text-muted">
          {form.scheduleDate && form.startTime && form.endTime
            ? "Saving blocks this time on your calendar."
            : form.dueDate
              ? "Due date appears on your calendar as a reminder block."
              : "Add a schedule or due date to show this task on your calendar."}
        </p>
      </div>
      <ModalFooter>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !form.title.trim() || !assignee}
          data-attr="manager-task-save"
        >
          {saving ? "Saving…" : editingId ? "Save task" : "Add task"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
