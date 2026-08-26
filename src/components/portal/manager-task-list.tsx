"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
import { Input, Select } from "@/components/ui/input";
import { useShallowTabId } from "@/components/ui/tabs";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { formatRangeLabel, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  MANAGER_TASKS_EVENT,
  createManagerTask,
  deleteManagerTask,
  fetchManagerTasks,
  reapplyManagerTasksToCalendar,
  updateManagerTask,
  type ManagerTask,
} from "@/lib/manager-tasks";
import {
  MANAGER_TASK_LIST_TAB_LABELS,
  MANAGER_TASK_LIST_TABS,
  managerTaskListHref,
  type ManagerTaskListTabId,
} from "@/lib/portal-detail-routes";
import { formatPacificDateTime } from "@/lib/pacific-time";
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

function formatTaskSchedule(task: ManagerTask): string {
  if (task.start && task.end) return formatRangeLabel(task.start, task.end);
  if (task.start) return formatPacificDateTime(task.start);
  return "No schedule";
}

function taskLocationLabel(task: ManagerTask): string | null {
  const parts = [task.propertyTitle, task.roomLabel].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const EMPTY_FORM = {
  title: "",
  notes: "",
  propertyId: "",
  roomLabel: "",
  scheduleDate: "",
  startTime: "",
  endTime: "",
};

export function ManagerTaskList({
  tabId: serverTabId,
  basePath = "/portal",
}: {
  tabId: ManagerTaskListTabId;
  basePath?: string;
}) {
  const tabId = useShallowTabId(serverTabId, MANAGER_TASK_LIST_TABS);
  const { showToast } = useAppUi();
  const { userId, ready } = useManagerUserId();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [propertyTick, setPropertyTick] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const roomOptions = useMemo(() => {
    if (!form.propertyId) return [];
    return getRoomOptionsForProperty(form.propertyId, { includeUnavailable: true }).filter((option) => option.value);
  }, [form.propertyId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      await syncScheduleRecordsFromServer({ force: true });
      const rows = await fetchManagerTasks(userId);
      setTasks(rows);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load tasks.");
    } finally {
      setLoading(false);
    }
  }, [showToast, userId]);

  useEffect(() => {
    if (!ready || !userId) return;
    void syncPropertyPipelineFromServer()
      .then(() => setPropertyTick((n) => n + 1))
      .catch(() => undefined);
    void refresh();
  }, [ready, userId, refresh]);

  useEffect(() => {
    const onChange = () => {
      if (!userId) return;
      void fetchManagerTasks(userId).then(setTasks).catch(() => undefined);
    };
    window.addEventListener(MANAGER_TASKS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_TASKS_EVENT, onChange);
  }, [userId]);

  useEffect(() => {
    if (!addOpen) return;
    setForm(EMPTY_FORM);
    setAssignee(null);
  }, [addOpen]);

  const openTasks = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);
  const visibleTasks = tabId === "completed" ? doneTasks : openTasks;

  const tabItems = useMemo(
    () =>
      MANAGER_TASK_LIST_TABS.map((id) => ({
        id,
        label: MANAGER_TASK_LIST_TAB_LABELS[id],
        href: managerTaskListHref(basePath, id),
        count: id === "completed" ? doneTasks.length : openTasks.length,
        dataAttr: `manager-task-list-tab-${id}`,
      })),
    [basePath, doneTasks.length, openTasks.length],
  );

  async function handleCreate() {
    if (!userId) return;
    setSaving(true);
    try {
      const start =
        form.scheduleDate && form.startTime
          ? combineLocalDateTime(form.scheduleDate, form.startTime)
          : undefined;
      const end =
        form.scheduleDate && form.endTime ? combineLocalDateTime(form.scheduleDate, form.endTime) : undefined;
      const property = propertyOptions.find((option) => option.id === form.propertyId);
      await createManagerTask(userId, {
        title: form.title,
        notes: form.notes,
        propertyId: form.propertyId || undefined,
        propertyTitle: property?.label,
        roomLabel: form.roomLabel || undefined,
        start,
        end,
        assignee,
      });
      reapplyManagerTasksToCalendar(userId);
      setAddOpen(false);
      await refresh();
      showToast(start && end ? "Task added to your calendar." : "Task added.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not add task.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleComplete(task: ManagerTask) {
    if (!userId) return;
    try {
      await updateManagerTask(userId, task.id, { completed: !task.completed });
      reapplyManagerTasksToCalendar(userId);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update task.");
    }
  }

  async function removeTask(taskId: string) {
    if (!userId) return;
    try {
      await deleteManagerTask(userId, taskId);
      reapplyManagerTasksToCalendar(userId);
      await refresh();
      showToast("Task removed.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete task.");
    }
  }

  function renderTaskRow(task: ManagerTask, completed = false) {
    const location = taskLocationLabel(task);
    return (
      <li key={task.id} className="flex items-start gap-3 px-4 py-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={completed}
          aria-label={`Mark ${task.title} ${completed ? "incomplete" : "complete"}`}
          onChange={() => void toggleComplete(task)}
        />
        <div className="min-w-0 flex-1">
          <p className={`font-semibold text-foreground ${completed ? "line-through" : ""}`}>{task.title}</p>
          <p className="text-sm text-muted">{formatTaskSchedule(task)}</p>
          {location ? <p className="text-xs text-muted">{location}</p> : null}
          {task.notes ? <p className="mt-1 text-sm text-muted">{task.notes}</p> : null}
        </div>
        <Button type="button" variant="ghost" className="text-[13px]" onClick={() => void removeTask(task.id)}>
          Delete
        </Button>
      </li>
    );
  }

  return (
    <ManagerPortalPageShell title="Task list">
      <PortalListControlStack
        className="mb-2"
        destinationRow={
          <DestinationNav
            items={tabItems}
            activeId={tabId}
            ariaLabel="Task status"
            itemLayout="equal"
            denseEqualRow
            className="max-w-none"
          />
        }
      />

      <div className={PORTAL_LIST_PAGE_BODY}>
        {loading ? <p className="text-sm text-muted">Loading…</p> : null}

        {!loading && visibleTasks.length > 0 ? (
          <ul
            className={`divide-y divide-border rounded-2xl border border-border bg-card ${tabId === "completed" ? "opacity-80" : ""}`}
          >
            {visibleTasks.map((task) => renderTaskRow(task, tabId === "completed"))}
          </ul>
        ) : null}

        {!loading && visibleTasks.length === 0 ? (
          <PortalDataTableEmpty
            message={tabId === "completed" ? "No completed tasks" : "No tasks in progress"}
          />
        ) : null}

        {tabId === "in-progress" ? (
          <PortalListAddRow
            label="Add task"
            icon={PORTAL_LIST_ADD_ICONS.request}
            onClick={() => setAddOpen(true)}
            dataAttr="manager-task-list-add"
          />
        ) : null}
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add task" dense assistantStrip={false}>
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
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  propertyId: e.target.value,
                  roomLabel: "",
                }))
              }
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
                value={form.roomLabel}
                onChange={(e) => setForm((current) => ({ ...current, roomLabel: e.target.value }))}
              >
                <option value="">No room</option>
                {roomOptions.map((option) => (
                  <option key={option.value} value={option.label}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Date (optional)</span>
            <Input
              type="date"
              value={form.scheduleDate}
              onChange={(e) => setForm((current) => ({ ...current, scheduleDate: e.target.value }))}
            />
          </label>
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
              : "Leave date and times blank to keep the task off your calendar."}
          </p>
        </div>
        <ModalFooter>
          <Button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving || !form.title.trim()}
            data-attr="manager-task-save"
          >
            {saving ? "Saving…" : "Add task"}
          </Button>
        </ModalFooter>
      </Modal>
    </ManagerPortalPageShell>
  );
}
