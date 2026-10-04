"use client";

/**
 * The manager Tasks row — the Services row shape (studio plan services-vendors-1004): one rounded
 * card per task, a neutral task tile, the task as the title, "<house> · <room>" as the place line,
 * and two glyph facts: who ("No one yet" when open) and when. When is "Due Oct 5", a booked slot,
 * or — in red, never a pill — "Overdue · was due Oct 2". A completed task says "Completed Oct 1".
 * The ⋯ the list surface draws on a selectable row carries the row's own actions.
 *
 * No table, no columns, no priority/due pills: the tab already says the
 * bucket (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */

import { useState } from "react";
import { CalendarDays, CheckCircle2, ListChecks, UserRound } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { compactTaskRoomLabel, managerTaskDueInstant } from "@/lib/manager-task-display";
import { formatPortalRowDate } from "@/lib/portal-display-dates";
import { pacificStartOfTodayMs } from "@/lib/pacific-time";
import type { ManagerTask } from "@/lib/manager-tasks";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TaskDueState = "overdue" | "today" | "soon" | "later" | "none" | "done";

/**
 * Where a task's deadline sits relative to now, off `managerTaskDueInstant` — the SAME instant
 * the record page's `isManagerTaskLate` reads, so a row and the record it opens can never
 * disagree about whether a task is overdue.
 */
export function taskDueState(
  task: Pick<ManagerTask, "dueDate" | "start" | "end" | "urgency" | "completed">,
  nowMs: number,
): TaskDueState {
  if (task.completed) return "done";
  const due = managerTaskDueInstant(task);
  if (due == null) return "none";
  if (due <= nowMs) return "overdue";
  const startOfToday = pacificStartOfTodayMs(nowMs);
  if (due <= startOfToday + DAY_MS) return "today";
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
  task: Pick<ManagerTask, "dueDate" | "start" | "end" | "urgency" | "completed">,
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
  /** @deprecated The assignee reads from the facts; kept so callers need not change. */
  viewerUserId?: string | null;
  /** True on the Completed tab — swaps the due fact for a completed date. */
  showDoneDate?: boolean;
  formatRange: (start: string, end: string) => string;
  checked?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const [nowMs] = useState(() => Date.now());
  const assigneeName = task.assignee?.name?.trim() ?? "";
  const room = compactTaskRoomLabel(task.roomLabel);
  const place = [propertyLabel, room].filter(Boolean).join(" · ") || "No property";
  const completed = showDoneDate || task.completed;
  // `completedAt` is stamped when the task is ticked off and cleared when it is reopened.
  // `updatedAt` is the fallback for tasks completed before that field existed — on those an
  // unrelated later edit still moves the date, which is why it is no longer the primary.
  const completedOn = completed ? formatPortalRowDate(task.completedAt || task.updatedAt) : "";
  const overdueOn = !completed && taskDueState(task, nowMs) === "overdue";
  const overdueDate = !overdueOn
    ? ""
    : task.start && task.end
      ? formatRange(task.start, task.end)
      : formatPortalRowDate(task.dueDate || task.start);

  return (
    <PortalApplicantRecordRow
      name={task.title}
      tileIcon={ListChecks}
      address={place}
      facts={
        completed ? (
          <>
            <PortalRowFact icon={CheckCircle2}>{completedOn ? `Completed ${completedOn}` : "Completed"}</PortalRowFact>
            {assigneeName ? <PortalRowFact icon={UserRound}>{assigneeName}</PortalRowFact> : null}
          </>
        ) : (
          <>
            <PortalRowFact icon={UserRound}>{assigneeName || "No one yet"}</PortalRowFact>
            {overdueOn ? (
              <PortalRowFact icon={CalendarDays} tone="danger">
                {overdueDate ? `Overdue · was due ${overdueDate}` : "Overdue"}
              </PortalRowFact>
            ) : (
              <PortalRowFact icon={CalendarDays}>{taskDueLabel(task, formatRange, nowMs)}</PortalRowFact>
            )}
          </>
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
