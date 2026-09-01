"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
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
import {
  ManagerLegacyServiceIntakeForm,
  type ServiceIntakeFooterState,
} from "@/components/portal/manager-legacy-service-intake-form";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import {
  buildManagerTaskComposePrefill,
  buildManagerTaskResidentOptions,
  createManagerTourFromTaskForm,
  ensureManagerTaskResidentDirectory,
  MANAGER_TASK_FORM_KIND_LABELS,
  MANAGER_TASK_FORM_KINDS,
  managerTaskFormKindFromTaskType,
  managerTaskTypeFromFormKind,
  residentsForManagerTaskProperty,
  type ManagerTaskFormKind,
} from "@/lib/manager-task-form-support";
import {
  createManagerTask,
  fetchManagerTasks,
  inferManagerTaskUrgency,
  MANAGER_TASK_PRIORITIES,
  MANAGER_TASK_PRIORITY_LABELS,
  MANAGER_TASK_URGENCIES,
  MANAGER_TASK_URGENCY_LABELS,
  reapplyManagerTasksToCalendar,
  updateManagerTask,
  type ManagerTaskPriority,
  type ManagerTaskUrgency,
} from "@/lib/manager-tasks";
import { scheduledTaskTitleForTour } from "@/lib/manager-scheduled-work-tasks";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";
import type { ResidentMaintenanceCategoryLabel } from "@/lib/work-order-taxonomy";
import type { WorkAssignee } from "@/lib/work-assignment";
import { cn } from "@/lib/utils";

const TOUR_DURATION_OPTIONS = [
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
];

const WORK_ORDER_CATEGORY_OPTIONS: ResidentMaintenanceCategoryLabel[] = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Access / Locks",
  "General",
];

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

function defaultTourScheduleFields(): { scheduleDate: string; startTime: string } {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const hour = d.getHours();
  if (hour >= 17 || hour < 9) {
    if (hour >= 17) d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  }
  return {
    scheduleDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    startTime: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

const EMPTY_FORM = {
  taskKind: "general" as ManagerTaskFormKind,
  // A new task is a booked slot by default, matching the schedule fields below.
  urgency: "scheduled" as ManagerTaskUrgency,
  priority: "medium" as ManagerTaskPriority,
  title: "",
  notes: "",
  propertyId: "",
  roomLabel: "",
  scheduleDate: "",
  dueDate: "",
  startTime: "",
  endTime: "",
  durationMinutes: "60",
  guestName: "",
  guestEmail: "",
  guestPhone: "",
  residentEmail: "",
  workOrderCategory: "General" as ResidentMaintenanceCategoryLabel,
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
  onSaved?: (composePrefill?: ManagerComposePrefill | null) => void;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId });
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [selectedRoomValue, setSelectedRoomValue] = useState("");
  const [residentTick, setResidentTick] = useState(0);
  const [serviceFooter, setServiceFooter] = useState<ServiceIntakeFooterState | null>(null);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(managerUserId),
    [managerUserId, propertyTick],
  );

  const residentOptions = useMemo(() => {
    void residentTick;
    return buildManagerTaskResidentOptions(managerUserId);
  }, [managerUserId, residentTick]);

  const selectedProperty = useMemo(
    () => propertyOptions.find((option) => option.id === form.propertyId) ?? null,
    [form.propertyId, propertyOptions],
  );

  const residentsForProperty = useMemo(
    () =>
      residentsForManagerTaskProperty(
        residentOptions,
        form.propertyId,
        selectedProperty?.label ?? "",
      ),
    [form.propertyId, residentOptions, selectedProperty?.label],
  );

  const roomOptions = useMemo(() => {
    if (!form.propertyId) return [];
    return getRoomOptionsForProperty(form.propertyId, { includeUnavailable: true }).filter((option) => option.value);
  }, [form.propertyId]);

  const isTour = form.taskKind === "tour";
  const isWorkOrder = form.taskKind === "work-order";
  const isCheckIn = form.taskKind === "check-in";
  const isCheckOut = form.taskKind === "check-out";
  const isTurnover = isCheckIn || isCheckOut;
  const workOrderNeedsResident = isWorkOrder && form.workOrderCategory !== "General";
  const showResidentPicker =
    workOrderNeedsResident || (isTurnover && Boolean(form.propertyId));
  const propertyRequired =
    form.taskKind === "tour" ||
    form.taskKind === "work-order" ||
    isTurnover;
  // A due date belongs to the deadline timing only: a scheduled task has a slot
  // instead, and an urgent one is deliberately dateless.
  const showDueDate = form.urgency === "deadline" && !isTour;
  const useServiceIntakeForm = isWorkOrder && !editingId;

  useEffect(() => {
    if (!open || !useServiceIntakeForm) setServiceFooter(null);
  }, [open, useServiceIntakeForm, form.taskKind]);

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_FORM);
      setAssignee(null);
      setSelectedRoomValue("");
      return;
    }
    void ensureManagerTaskResidentDirectory().then(() => setResidentTick((n) => n + 1));
    if (!editingId && teamMembers.length > 0) {
      const self = teamMembers.find((m) => m.userId === managerUserId) ?? teamMembers[0];
      if (self) {
        const nextAssignee: WorkAssignee = {
          type: "team",
          id: self.userId,
          name: self.name?.trim() || self.email?.trim() || "You",
        };
        // Keep the EXISTING object when the value is unchanged. `teamMembers` is
        // memoized on a relationship-sync tick, so it gets a fresh identity every
        // time that sync fires; storing a new-but-equal object each run re-rendered,
        // which re-ran this effect, which stored another — "Maximum update depth
        // exceeded" as soon as the sync was chatty. Returning `current` makes React
        // bail out of the render instead.
        setAssignee((current) =>
          current &&
          current.type === nextAssignee.type &&
          current.id === nextAssignee.id &&
          current.name === nextAssignee.name
            ? current
            : nextAssignee,
        );
      }
    }
    if (!editingId) return;
    let cancelled = false;
    void fetchManagerTasks(managerUserId).then((tasks) => {
      if (cancelled) return;
      const task = tasks.find((row) => row.id === editingId);
      if (!task) return;
      setForm({
        ...EMPTY_FORM,
        taskKind: managerTaskFormKindFromTaskType(task.taskType),
        title: task.title,
        notes: task.notes ?? "",
        propertyId: task.propertyId ?? "",
        roomLabel: task.roomLabel ?? "",
        scheduleDate: localDatePart(task.start),
        dueDate: localDatePart(task.dueDate),
        startTime: localTimePart(task.start),
        endTime: localTimePart(task.end),
        // Rows saved before these fields existed carry no urgency; read it off
        // the dates they already have rather than assuming a reserved slot.
        urgency: inferManagerTaskUrgency(task),
        priority: task.priority ?? "medium",
      });
      setAssignee(task.assignee ?? null);
      const match = getRoomOptionsForProperty(task.propertyId ?? "", { includeUnavailable: true }).find(
        (option) =>
          roomNameFromOptionLabel(option.label) ===
          (task.roomLabel?.split(" · ")[0]?.trim() ?? task.roomLabel),
      );
      setSelectedRoomValue(match?.value ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [open, editingId, managerUserId, teamMembers]);

  function updateTaskKind(nextKind: ManagerTaskFormKind) {
    setForm((current) => {
      const next = { ...current, taskKind: nextKind };
      if (nextKind === "tour" && !current.scheduleDate) {
        Object.assign(next, defaultTourScheduleFields());
      }
      if (nextKind === "work-order" && current.residentEmail) {
        const resident = residentOptions.find((row) => row.residentEmail === current.residentEmail);
        if (resident?.propertyId) next.propertyId = resident.propertyId;
      }
      return next;
    });
  }

  async function handleSave() {
    if (useServiceIntakeForm) return;
    if (!assignee) {
      showToast("Choose who this task is assigned to.");
      return;
    }
    if (propertyRequired && !form.propertyId) {
      showToast("Choose a property.");
      return;
    }
    if (isTour) {
      if (!form.guestName.trim()) {
        showToast("Guest name is required for a tour.");
        return;
      }
      if (!form.scheduleDate || !form.startTime) {
        showToast("Pick a schedule date and start time for the tour.");
        return;
      }
    }
    if (isWorkOrder && workOrderNeedsResident && !form.residentEmail) {
      showToast("Choose a resident for the service request.");
      return;
    }

    setSaving(true);
    try {
      const start =
        form.scheduleDate && form.startTime
          ? combineLocalDateTime(form.scheduleDate, form.startTime)
          : undefined;
      let end =
        form.scheduleDate && form.endTime
          ? combineLocalDateTime(form.scheduleDate, form.endTime)
          : undefined;
      if (isTour && start && !end) {
        const durationMs = Math.max(15, Number(form.durationMinutes) || 60) * 60 * 1000;
        end = new Date(Date.parse(start) + durationMs).toISOString();
      }
      const dueDate =
        !start && !end && form.dueDate ? combineLocalDateTime(form.dueDate, "23:59") : undefined;
      const property = propertyOptions.find((option) => option.id === form.propertyId);
      const roomOption = roomOptions.find((option) => option.value === selectedRoomValue);
      const roomLabel = roomOption
        ? roomNameFromOptionLabel(roomOption.label)
        : form.roomLabel.trim() || undefined;
      const cleared = editingId ? "" : undefined;

      const taskTitle = isTour
        ? scheduledTaskTitleForTour(form.guestName.trim() || form.title.trim())
        : form.title.trim() ||
          (isCheckIn ? "Check in" : isCheckOut ? "Check out" : "");

      if (!taskTitle) {
        showToast(isTour ? "Add a guest name or title." : "Add a task title.");
        return;
      }

      let composePrefill: ManagerComposePrefill | null = null;
      const scheduleLabel =
        start && end ? formatRangeLabel(start, end) : start ? formatRangeLabel(start, start) : undefined;

      if (!editingId && isTour) {
        const tourResult = await createManagerTourFromTaskForm({
          managerUserId,
          propertyId: form.propertyId,
          propertyLabel: selectedProperty?.label,
          roomLabel,
          guestName: form.guestName.trim(),
          guestEmail: form.guestEmail.trim() || undefined,
          guestPhone: form.guestPhone.trim() || undefined,
          start: start!,
          end: end!,
          notes: form.notes.trim() || undefined,
          assignee,
        });
        if (!tourResult.ok) {
          showToast(tourResult.error);
          return;
        }
        composePrefill = buildManagerTaskComposePrefill({
          kind: "tour",
          title: taskTitle,
          notes: form.notes,
          propertyLabel: selectedProperty?.label,
          scheduleLabel,
          recipientEmail: form.guestEmail.trim() || undefined,
          recipientName: form.guestName.trim(),
        });
      }

      const input = {
        title: taskTitle,
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
        urgency: form.urgency,
        priority: form.priority,
        taskType: managerTaskTypeFromFormKind(form.taskKind),
      };

      if (editingId) {
        await updateManagerTask(managerUserId, editingId, input);
      } else {
        await createManagerTask(managerUserId, input);
      }

      reapplyManagerTasksToCalendar(managerUserId);
      onClose();
      onSaved?.(composePrefill);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save task.");
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    Boolean(assignee) &&
    Boolean(form.title.trim() || (isTour && form.guestName.trim()) || isTurnover) &&
    (!propertyRequired || Boolean(form.propertyId)) &&
    (!isTour || Boolean(form.scheduleDate && form.startTime)) &&
    (!isWorkOrder || !workOrderNeedsResident || Boolean(form.residentEmail));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingId ? "Edit task" : "Add task"}
      dense
      assistantContext={editingId ? "Edit task" : "Add task"}
      footer={
        useServiceIntakeForm && serviceFooter ? (
          <ModalFooter>
            <Button
              type="button"
              onClick={serviceFooter.submit}
              disabled={serviceFooter.saving || !serviceFooter.canSubmit}
              data-attr="manager-task-save"
            >
              {serviceFooter.saving ? "Saving…" : "Add task"}
            </Button>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !canSave}
              data-attr="manager-task-save"
            >
              {saving ? "Saving…" : editingId ? "Save task" : "Add task"}
            </Button>
          </ModalFooter>
        )
      }
    >
      <div className="shrink-0 pb-4">
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-kind">
          Task type
        </label>
        <Select
          id="manager-task-kind"
          className="mt-1"
          value={form.taskKind}
          onChange={(e) => updateTaskKind(e.target.value as ManagerTaskFormKind)}
          data-attr="manager-task-kind"
        >
          {MANAGER_TASK_FORM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MANAGER_TASK_FORM_KIND_LABELS[kind]}
            </option>
          ))}
        </Select>
      </div>

      {useServiceIntakeForm ? (
        <ManagerLegacyServiceIntakeForm
          open={open}
          managerUserId={managerUserId}
          submitLabel="Add task"
          onRegisterFooter={setServiceFooter}
          onComplete={(composePrefill) => {
            onClose();
            onSaved?.(composePrefill ?? null);
          }}
        />
      ) : (
      <div className={PORTAL_MODAL_BODY_SCROLL_CLASS}>
      <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
        {isTour ? (
          <>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-guest-name">
                Guest name
              </label>
              <Input
                id="manager-task-guest-name"
                value={form.guestName}
                onChange={(e) => setForm((current) => ({ ...current, guestName: e.target.value }))}
                placeholder="Jane Smith"
                data-attr="manager-task-guest-name"
              />
            </div>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-guest-email">
                Guest email (optional)
              </label>
              <Input
                id="manager-task-guest-email"
                type="email"
                value={form.guestEmail}
                onChange={(e) => setForm((current) => ({ ...current, guestEmail: e.target.value }))}
                placeholder="jane@example.com"
                data-attr="manager-task-guest-email"
              />
            </div>
            <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-guest-phone">
                Guest phone (optional)
              </label>
              <Input
                id="manager-task-guest-phone"
                type="tel"
                value={form.guestPhone}
                onChange={(e) => setForm((current) => ({ ...current, guestPhone: e.target.value }))}
                placeholder="(555) 555-0100"
                data-attr="manager-task-guest-phone"
              />
            </div>
          </>
        ) : (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-title">
              {isWorkOrder ? "Task title" : "Description"}
            </label>
            <Input
              id="manager-task-title"
              aria-label="Task title"
              value={form.title}
              onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))}
              placeholder={
                isCheckIn
                  ? "Linen bag, early check-in, keys…"
                  : isCheckOut
                    ? "Final walk-through, keys, cleaning…"
                    : isWorkOrder
                      ? "Leaky faucet in kitchen"
                      : "Inspect unit, meet vendor, follow up…"
              }
              data-attr="manager-task-title-input"
            />
          </div>
        )}

        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
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
        </div>

        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-property">
            Property{propertyRequired ? "" : " (optional)"}
          </label>
          <Select
            id="manager-task-property"
            value={form.propertyId}
            onChange={(e) => {
              const propertyId = e.target.value;
              setForm((current) => ({
                ...current,
                propertyId,
                roomLabel: "",
                residentEmail:
                  current.residentEmail &&
                  residentsForManagerTaskProperty(
                    residentOptions,
                    propertyId,
                    propertyOptions.find((option) => option.id === propertyId)?.label ?? "",
                  ).some((row) => row.residentEmail === current.residentEmail)
                    ? current.residentEmail
                    : "",
              }));
              setSelectedRoomValue("");
            }}
            data-attr="manager-task-property"
          >
            <option value="">{propertyRequired ? "Select property" : "No property"}</option>
            {propertyOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {isWorkOrder ? (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-work-order-category">
              Category
            </label>
            <Select
              id="manager-task-work-order-category"
              value={form.workOrderCategory}
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  workOrderCategory: e.target.value as ResidentMaintenanceCategoryLabel,
                  residentEmail:
                    e.target.value === "General" ? "" : current.residentEmail,
                }))
              }
              data-attr="manager-task-work-order-category"
            >
              {WORK_ORDER_CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {showResidentPicker ? (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-resident">
              Resident{workOrderNeedsResident ? "" : " (optional)"}
            </label>
            <Select
              id="manager-task-resident"
              value={form.residentEmail}
              onChange={(e) => {
                const residentEmail = e.target.value;
                const resident = residentsForProperty.find((row) => row.residentEmail === residentEmail);
                setForm((current) => ({
                  ...current,
                  residentEmail,
                  propertyId: resident?.propertyId || current.propertyId,
                }));
              }}
              data-attr="manager-task-resident"
            >
              <option value="">Select resident</option>
              {residentsForProperty.map((resident) => (
                <option key={resident.residentEmail} value={resident.residentEmail}>
                  {resident.residentName} · {resident.propertyLabel}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {form.propertyId ? (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-room">
              Room (optional)
            </label>
            <Select
              id="manager-task-room"
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
              data-attr="manager-task-room"
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

        {isTour ? (
          <>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-schedule-date">
                Schedule date
              </label>
              <Input
                id="manager-task-schedule-date"
                type="date"
                value={form.scheduleDate}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    scheduleDate: e.target.value,
                  }))
                }
                data-attr="manager-task-schedule-date"
              />
            </div>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-tour-start-time">
                Start time
              </label>
              <Input
                id="manager-task-tour-start-time"
                type="time"
                value={form.startTime}
                onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))}
                disabled={!form.scheduleDate}
                data-attr="manager-task-tour-start-time"
              />
            </div>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-duration">
                Duration
              </label>
              <Select
                id="manager-task-duration"
                value={form.durationMinutes}
                onChange={(e) =>
                  setForm((current) => ({ ...current, durationMinutes: e.target.value }))
                }
                data-attr="manager-task-duration"
              >
                {TOUR_DURATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          </>
        ) : (
          <>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-urgency">
                Timing
              </label>
              <Select
                id="manager-task-urgency"
                value={form.urgency}
                onChange={(e) =>
                  setForm((current) => {
                    const urgency = e.target.value as ManagerTaskUrgency;
                    // Each timing means a different set of dates. Clear the ones
                    // the new choice does not use, so a task cannot claim a
                    // calendar slot it no longer has, or keep a stale due date.
                    if (urgency === "urgent") {
                      return { ...current, urgency, scheduleDate: "", dueDate: "", startTime: "", endTime: "" };
                    }
                    if (urgency === "deadline") {
                      return { ...current, urgency, scheduleDate: "", startTime: "", endTime: "" };
                    }
                    return { ...current, urgency, dueDate: "" };
                  })
                }
                data-attr="manager-task-urgency"
              >
                {MANAGER_TASK_URGENCIES.map((value) => (
                  <option key={value} value={value}>
                    {MANAGER_TASK_URGENCY_LABELS[value]}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted">
                {form.urgency === "scheduled"
                  ? "Books a slot on the calendar."
                  : form.urgency === "deadline"
                    ? "Just a time to finish by — no slot is reserved."
                    : "No due date — still needs to get done."}
              </p>
            </div>

            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-priority">
                Priority
              </label>
              <Select
                id="manager-task-priority"
                value={form.priority}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    priority: e.target.value as ManagerTaskPriority,
                  }))
                }
                data-attr="manager-task-priority"
              >
                {MANAGER_TASK_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {MANAGER_TASK_PRIORITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>

            {form.urgency === "scheduled" ? (
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-schedule-date">
                Schedule date (optional)
              </label>
              <Input
                id="manager-task-schedule-date"
                type="date"
                value={form.scheduleDate}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    scheduleDate: e.target.value,
                    dueDate: e.target.value ? "" : current.dueDate,
                  }))
                }
                data-attr="manager-task-schedule-date"
              />
            </div>
            ) : null}

            {showDueDate ? (
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-due-date">
                  Due date
                </label>
                <Input
                  id="manager-task-due-date"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((current) => ({ ...current, dueDate: e.target.value }))}
                  data-attr="manager-task-due-date"
                />
              </div>
            ) : null}

            {form.urgency === "scheduled" ? (
            <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-start-time">
                  Start time (optional)
                </label>
                <Input
                  id="manager-task-start-time"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm((current) => ({ ...current, startTime: e.target.value }))}
                  disabled={!form.scheduleDate}
                  data-attr="manager-task-start-time"
                />
              </div>
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-end-time">
                  End time (optional)
                </label>
                <Input
                  id="manager-task-end-time"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm((current) => ({ ...current, endTime: e.target.value }))}
                  disabled={!form.scheduleDate}
                  data-attr="manager-task-end-time"
                />
              </div>
            </div>
            ) : null}
          </>
        )}

        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="manager-task-notes">
            Notes (optional)
          </label>
          <textarea
            id="manager-task-notes"
            className="min-h-[88px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
            value={form.notes}
            onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
            data-attr="manager-task-notes"
          />
        </div>

        <p className={cn("text-xs text-muted", PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
          {isTour
            ? "Saving schedules the tour and adds it to your task list and calendar."
            : isWorkOrder
              ? "Saving creates the service request and a linked calendar entry when scheduled."
              : form.scheduleDate && form.startTime && form.endTime
                ? "Saving blocks this time on your calendar."
                : form.dueDate
                  ? "Due date appears on your calendar as a reminder block."
                  : "Add a schedule or due date to show this task on your calendar."}
          {!editingId && (isTour || isWorkOrder && workOrderNeedsResident)
            ? " You can notify the guest or resident on the next screen."
            : null}
        </p>
      </div>
      </div>
      )}
    </Modal>
  );
}
