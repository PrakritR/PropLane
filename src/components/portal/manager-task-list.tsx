"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  EVENT_DURATION_PRESET_MINUTES,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  MANAGER_TASKS_EVENT,
  createManagerTask,
  deleteManagerTask,
  fetchManagerTasks,
  updateManagerTask,
  type ManagerTask,
} from "@/lib/manager-tasks";

function toLocalDateInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toLocalTimeInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "09:00";
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

function combineLocalDateTime(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(h) || Number.isNaN(min)) {
    throw new Error("Choose a valid date and time.");
  }
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString();
}

function defaultScheduleDateTime(): { date: string; time: string } {
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  return { date: toLocalDateInputValue(next.toISOString()), time: toLocalTimeInputValue(next.toISOString()) };
}

export function ManagerTaskList() {
  const { showToast } = useAppUi();
  const { userId, ready } = useManagerUserId();
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduleDate, setScheduleDate] = useState(() => defaultScheduleDateTime().date);
  const [scheduleTime, setScheduleTime] = useState(() => defaultScheduleDateTime().time);
  const [durationMinutes, setDurationMinutes] = useState<number>(30);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const rows = await fetchManagerTasks(userId);
      setTasks(rows);
      await syncScheduleRecordsFromServer({ force: true });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load tasks.");
    } finally {
      setLoading(false);
    }
  }, [showToast, userId]);

  useEffect(() => {
    if (!ready || !userId) return;
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

  const openTasks = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);

  async function handleCreate() {
    if (!userId) return;
    setSaving(true);
    try {
      const start = combineLocalDateTime(scheduleDate, scheduleTime);
      await createManagerTask(userId, { title, notes, start, durationMinutes });
      await syncScheduleRecordsFromServer({ force: true });
      setAddOpen(false);
      setTitle("");
      setNotes("");
      const defaults = defaultScheduleDateTime();
      setScheduleDate(defaults.date);
      setScheduleTime(defaults.time);
      setDurationMinutes(30);
      await refresh();
      showToast("Task added to your schedule.");
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
      await syncScheduleRecordsFromServer({ force: true });
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update task.");
    }
  }

  async function removeTask(taskId: string) {
    if (!userId) return;
    try {
      await deleteManagerTask(userId, taskId);
      await syncScheduleRecordsFromServer({ force: true });
      await refresh();
      showToast("Task removed.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete task.");
    }
  }

  return (
    <ManagerPortalPageShell title="Task list">
      <div className={PORTAL_LIST_PAGE_BODY}>
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tasks.length > 0 ? (
          <div className="space-y-6">
            {openTasks.length ? (
              <section className="space-y-2">
                <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Open</h2>
                <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
                  {openTasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={false}
                        aria-label={`Mark ${task.title} complete`}
                        onChange={() => void toggleComplete(task)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground">{task.title}</p>
                        <p className="text-sm text-muted">{formatPacificDateTime(task.start)}</p>
                        {task.propertyTitle ? <p className="text-xs text-muted">{task.propertyTitle}</p> : null}
                        {task.notes ? <p className="mt-1 text-sm text-muted">{task.notes}</p> : null}
                      </div>
                      <Button type="button" variant="ghost" className="text-[13px]" onClick={() => void removeTask(task.id)}>
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {doneTasks.length ? (
              <section className="space-y-2">
                <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Completed</h2>
                <ul className="divide-y divide-border rounded-2xl border border-border bg-card opacity-80">
                  {doneTasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked
                        aria-label={`Mark ${task.title} incomplete`}
                        onChange={() => void toggleComplete(task)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground line-through">{task.title}</p>
                        <p className="text-sm text-muted">{formatPacificDateTime(task.start)}</p>
                      </div>
                      <Button type="button" variant="ghost" className="text-[13px]" onClick={() => void removeTask(task.id)}>
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        <PortalListAddRow
          label="Add task"
          icon={PORTAL_LIST_ADD_ICONS.request}
          onClick={() => setAddOpen(true)}
          dataAttr="manager-task-list-add"
        />
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add task" dense assistantStrip={false}>
        <div className="space-y-3">
          <Input
            aria-label="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Inspect unit, meet vendor, follow up…"
            data-attr="manager-task-title-input"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-foreground">Date</span>
              <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-foreground">Time</span>
              <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
            </label>
          </div>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Duration</span>
            <select
              className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
            >
              {EVENT_DURATION_PRESET_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-foreground">Notes (optional)</span>
            <textarea
              className="min-h-[80px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted">Saving adds this block to your Tours schedule.</p>
        </div>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving || !title.trim()}
            data-attr="manager-task-save"
          >
            {saving ? "Saving…" : "Add to schedule"}
          </Button>
        </ModalFooter>
      </Modal>
    </ManagerPortalPageShell>
  );
}
