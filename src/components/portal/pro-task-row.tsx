"use client";

/**
 * The manager Tasks row — one white card per task, the shape every other
 * portal list has (AGENTS.md → Portal UI system: "Every list tab copies
 * Properties"). A tile (assignee initials, or a task glyph when unassigned),
 * the task title, "<house> · <room/unit>" as the place line, glyph facts —
 * due date, assignee, priority only when it is not Normal, a completed date
 * on the Done tab — and the ⋯ the list surface draws on a selectable row.
 *
 * No table, no columns, no priority/due pills: the tab already says the
 * bucket, and anything else a row has to say is plain fact text with a glyph
 * (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */

import { CalendarDays, CheckCircle2, ClipboardList, Flag, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { compactTaskRoomLabel } from "@/lib/manager-task-display";
import {
  MANAGER_TASK_PRIORITY_LABELS,
  type ManagerTask,
} from "@/lib/manager-tasks";

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

function taskAssigneeInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** Tile: assignee initials when assigned, a task glyph otherwise — never a bare avatar-less box. */
function TaskRowTile({ assigneeName }: { assigneeName: string }) {
  const tileClass = "grid h-[4.125rem] w-[5.5rem] place-items-center rounded-[10px] max-md:h-[3.125rem] max-md:w-16";
  if (assigneeName) {
    return (
      <div aria-hidden className={cn(tileClass, "bg-primary/[0.08] text-[20px] font-extrabold tracking-wide text-primary max-md:text-[16px]")}>
        {taskAssigneeInitials(assigneeName) || "?"}
      </div>
    );
  }
  return (
    <div aria-hidden className={cn(tileClass, "bg-accent/60 text-muted/80")}>
      <ClipboardList className="size-[22px]" strokeWidth={1.5} />
    </div>
  );
}

export function TaskListCardRow({
  task,
  propertyLabel,
  viewerUserId,
  showDoneDate = false,
  formatRange,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  task: ManagerTask;
  propertyLabel: string;
  /** The signed-in manager, so their own tasks read "You". */
  viewerUserId: string | null;
  /** True on the Done tab — swaps the due fact for a completed date. */
  showDoneDate?: boolean;
  formatRange: (start: string, end: string) => string;
  checked?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const assigneeName = task.assignee?.name?.trim() ?? "";
  const onViewer = Boolean(task.assignee && viewerUserId && task.assignee.id === viewerUserId);
  const assigneeText = assigneeName ? (onViewer ? "You" : assigneeName) : "Unassigned";
  const room = compactTaskRoomLabel(task.roomLabel);
  const place = [propertyLabel, room].filter(Boolean).join(" · ") || "No property";
  const priority = task.priority ?? "medium";

  return (
    <PortalPropertyRecordRow
      title={task.title}
      address={place}
      leading={<TaskRowTile assigneeName={assigneeName} />}
      leadingShape="square"
      facts={
        <>
          {showDoneDate ? (
            <PortalRowFact icon={CheckCircle2} srLabel="Completed">
              {shortDateLabel(task.updatedAt) || "Done"}
            </PortalRowFact>
          ) : (
            <PortalRowFact icon={CalendarDays} srLabel="Due">
              {taskDueFact(task, formatRange)}
            </PortalRowFact>
          )}
          <PortalRowFact icon={UserRound} srLabel="Assignee">
            {assigneeText}
          </PortalRowFact>
          {priority !== "medium" ? (
            <PortalRowFact icon={Flag} srLabel="Priority">
              {MANAGER_TASK_PRIORITY_LABELS[priority]}
            </PortalRowFact>
          ) : null}
        </>
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
