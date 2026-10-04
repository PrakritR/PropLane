"use client";

/**
 * The manager Tasks row — the Payments row (`PortalApplicantRecordRow`), one
 * rounded card per task with a gap between cards (AGENTS.md → Portal UI
 * system: "Every list tab copies Properties"). The tile is the assignee's
 * initials (the property glyph when nobody is assigned), the title is the
 * task, the place line is "<house> · <room/unit>", and the one fact is a dated
 * glyph — "Due Oct 5", "Overdue Oct 2" (same glyph, no red pill), or on the
 * Done tab "Completed Oct 2". The ⋯ the list surface draws on a selectable row
 * carries the row's own actions.
 *
 * No table, no columns, no priority/due pills: the tab already says the
 * bucket (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */

import { Building2, CalendarDays, CheckCircle2 } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { compactTaskRoomLabel } from "@/lib/manager-task-display";
import { formatPortalRowDate } from "@/lib/portal-display-dates";
import type { ManagerTask } from "@/lib/manager-tasks";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TaskDueState = "overdue" | "today" | "soon" | "later" | "none" | "done";

/** Where a task's deadline sits relative to now. Wall dates are read in local time. */
export function taskDueState(task: Pick<ManagerTask, "dueDate" | "start" | "completed">, nowMs: number): TaskDueState {
  if (task.completed) return "done";
  const raw = task.dueDate || task.start;
  if (!raw) return "none";
  const wall = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const due = wall ? new Date(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])).getTime() : new Date(raw).getTime();
  if (!Number.isFinite(due)) return "none";
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + DAY_MS;
  if (due < startOfToday) return "overdue";
  if (due < endOfToday) return "today";
  if (due < startOfToday + 7 * DAY_MS) return "soon";
  return "later";
}

function shortDateLabel(raw: string | undefined): string {
  if (!raw) return "";
  const wall = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = wall ? new Date(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])) : new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "Fri, Sep 25" for a bare due date, or "Fri, Sep 25, 1:30 PM – 2:30 PM" for a timed slot. */
export function taskDueFact(task: Pick<ManagerTask, "dueDate" | "start" | "end">, formatRange: (start: string, end: string) => string): string {
  if (task.start && task.end) return formatRange(task.start, task.end);
  return shortDateLabel(task.dueDate || task.start) || "No date";
}

/**
 * The row's dated fact: "Due Oct 5", "Overdue Oct 2", a timed slot as
 * "Due <range>", or "No due date". A finished task has no due fact.
 */
export function taskDueLabel(
  task: Pick<ManagerTask, "dueDate" | "start" | "end" | "completed">,
  formatRange: (start: string, end: string) => string,
  nowMs: number = Date.now(),
): string {
  const state = taskDueState(task, nowMs);
  if (state === "none") return "No due date";
  const word = state === "overdue" ? "Overdue" : "Due";
  if (task.start && task.end) return `${word} ${formatRange(task.start, task.end)}`;
  const date = formatPortalRowDate(task.dueDate || task.start, nowMs);
  return date ? `${word} ${date}` : "No due date";
}

export function TaskListCardRow({
  task,
  propertyLabel,
  showDoneDate = false,
  formatRange,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  task: ManagerTask;
  propertyLabel: string;
  /** @deprecated The assignee reads from the tile; kept so callers need not change. */
  viewerUserId?: string | null;
  /** True on the Done tab — swaps the due fact for a completed date. */
  showDoneDate?: boolean;
  formatRange: (start: string, end: string) => string;
  checked?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const assigneeName = task.assignee?.name?.trim() ?? "";
  const room = compactTaskRoomLabel(task.roomLabel);
  const place = [propertyLabel, room].filter(Boolean).join(" · ") || "No property";
  const completedOn = showDoneDate ? formatPortalRowDate(task.updatedAt) : "";

  return (
    <PortalApplicantRecordRow
      name={task.title}
      tileLabel={assigneeName || undefined}
      tileIcon={assigneeName ? undefined : Building2}
      address={place}
      facts={
        showDoneDate ? (
          <PortalRowFact icon={CheckCircle2}>{completedOn ? `Completed ${completedOn}` : "Completed"}</PortalRowFact>
        ) : (
          <PortalRowFact icon={CalendarDays}>{taskDueLabel(task, formatRange)}</PortalRowFact>
        )
      }
      checked={checked}
      onSelectedChange={onSelectedChange}
      onOpen={onOpen}
      // The row itself already opens the task record on click, so the ⋯
      // menu never repeats it as a "View" item.
      omitActionView
      dataAttr={dataAttr}
    />
  );
}
