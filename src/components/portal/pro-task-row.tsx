"use client";

/**
 * The shared task row — a table on desktop, two lines on a phone.
 *
 * Columns: status dot · task (title + one line of context) · property ·
 * assignee (avatar + name) · due (a chip when it is today or overdue) ·
 * priority (High / Normal / Low). Linear's issue list is the reference: one
 * row per task, the identifying facts in fixed columns so the eye can run
 * down any one of them, and colour reserved for the two things that matter
 * — how late it is and how important it is.
 *
 * On a phone the row is title + due chip, then context · property; the
 * assignee avatar shows only when the task is on somebody OTHER than the
 * viewer, because "assigned to me" is the default a manager's own list has.
 */

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { InboxAvatar } from "@/components/portal/portal-inbox-ui";
import { cn } from "@/lib/utils";
import {
  MANAGER_TASK_PRIORITY_LABELS,
  type ManagerTask,
  type ManagerTaskPriority,
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

function dueLabel(task: Pick<ManagerTask, "dueDate" | "start">, state: TaskDueState, nowMs: number): string {
  const raw = task.dueDate || task.start;
  if (!raw || state === "none") return "No date";
  const wall = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = wall ? new Date(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])) : new Date(raw);
  if (state === "overdue") {
    const days = Math.max(1, Math.floor((nowMs - d.getTime()) / DAY_MS));
    return `Overdue · ${days}d`;
  }
  if (state === "today") return "Today";
  const dayAfter = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate() + 1);
  if (d.toDateString() === dayAfter.toDateString()) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** The due column: a chip when it is today or overdue, plain text otherwise. */
export function TaskDueChip({ task, nowMs }: { task: ManagerTask; nowMs: number }) {
  const state = taskDueState(task, nowMs);
  const label = dueLabel(task, state, nowMs);
  if (state === "overdue" || state === "today") {
    return (
      <span
        className={cn(
          "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
          state === "overdue"
            ? "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]"
            : "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
        )}
        data-attr={`task-due-${state}`}
      >
        {label}
      </span>
    );
  }
  return (
    <span className={cn("whitespace-nowrap text-[12.5px]", state === "none" ? "text-muted/60" : "text-muted")}>
      {label}
    </span>
  );
}

const PRIORITY_CHIP: Record<ManagerTaskPriority, string> = {
  high: "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
  medium: "bg-[var(--secondary)] text-muted",
  low: "bg-[var(--secondary)] text-muted/70",
};

export function TaskPriorityChip({ priority }: { priority?: ManagerTaskPriority }) {
  const p: ManagerTaskPriority = priority ?? "medium";
  return (
    <span
      className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", PRIORITY_CHIP[p])}
      data-attr={`manager-task-priority-${p}`}
    >
      {p === "medium" ? "Normal" : MANAGER_TASK_PRIORITY_LABELS[p]}
    </span>
  );
}

const STATUS_DOT: Record<TaskDueState, string> = {
  overdue: "bg-[var(--status-overdue-fg)]",
  today: "bg-[var(--status-pending-fg)]",
  soon: "bg-primary",
  later: "bg-primary/60",
  none: "border border-muted/50",
  done: "bg-[var(--status-confirmed-fg)]",
};

/** The desktop grid every row and the header share. */
export const TASK_ROW_GRID =
  "md:grid md:grid-cols-[28px_14px_minmax(0,1fr)_minmax(0,150px)_minmax(0,150px)_112px_84px] md:items-center md:gap-x-3";

export function TaskTableHeader() {
  return (
    <div
      className={cn("hidden px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted/70", TASK_ROW_GRID)}
      aria-hidden
    >
      <span />
      <span />
      <span>Task</span>
      <span>Property</span>
      <span>Assignee</span>
      <span>Due</span>
      <span>Priority</span>
    </div>
  );
}

export function TaskTableRow({
  task,
  context,
  propertyLabel,
  /** False when the list is already grouped by property — the header says it. */
  showPropertyOnPhone = true,
  viewerUserId,
  nowMs,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  task: ManagerTask;
  /** One line under the title — location, schedule, checklist progress. */
  context?: string;
  propertyLabel: string;
  showPropertyOnPhone?: boolean;
  /** The signed-in manager, so a task on them shows no avatar on a phone. */
  viewerUserId: string | null;
  nowMs: number;
  checked?: boolean;
  onSelectedChange?: (next: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const state = taskDueState(task, nowMs);
  const assigneeName = task.assignee?.name?.trim() || "";
  const onViewer = Boolean(task.assignee && viewerUserId && task.assignee.id === viewerUserId);
  const assignee: ReactNode = assigneeName ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <InboxAvatar name={assigneeName} className="h-6 w-6 shrink-0 text-[10px]" />
      <span className="truncate text-[13px] text-foreground">{onViewer ? "You" : assigneeName}</span>
    </span>
  ) : (
    <span className="text-[12.5px] text-muted/60">Unassigned</span>
  );

  return (
    <div
      className={cn(
        "portal-task-row flex w-full items-start gap-2 border-b border-border/60 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-foreground/[0.025]",
        checked && "bg-primary/[0.04]",
        TASK_ROW_GRID,
      )}
      data-attr={dataAttr}
    >
      {onSelectedChange ? (
        <RowSelectCheckbox
          wrapperClassName="mr-0 self-center"
          checked={checked}
          onChange={(e) => onSelectedChange(e.target.checked)}
          aria-label={`Select ${task.title}`}
        />
      ) : (
        <span className="hidden md:block" />
      )}
      <span className={cn("mt-2 h-2.5 w-2.5 shrink-0 rounded-full md:mt-0", STATUS_DOT[state])} aria-hidden />
      <button type="button" onClick={onOpen} className="flex min-h-9 min-w-0 flex-1 flex-col justify-center text-left md:min-w-0">
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn("truncate text-[14px] font-semibold text-foreground", task.completed && "text-muted line-through")}>
            {task.title}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted/60 md:hidden" aria-hidden />
        </span>
        {context ? <span className="truncate text-[12px] text-muted">{context}</span> : null}
        {/* Phone second line: property, and the assignee only when it is not the viewer. */}
        {(showPropertyOnPhone && propertyLabel) || (assigneeName && !onViewer) ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted md:hidden">
            {showPropertyOnPhone && propertyLabel ? <span className="truncate">{propertyLabel}</span> : null}
            {assigneeName && !onViewer ? (
              <InboxAvatar name={assigneeName} className="h-5 w-5 shrink-0 text-[9px]" />
            ) : null}
          </span>
        ) : null}
      </button>
      <span className="hidden min-w-0 truncate text-[13px] text-foreground md:block">{propertyLabel || "—"}</span>
      <span className="hidden min-w-0 md:block">{assignee}</span>
      <span className="ml-auto shrink-0 self-center md:ml-0">
        <TaskDueChip task={task} nowMs={nowMs} />
      </span>
      <span className="hidden md:block">
        <TaskPriorityChip priority={task.priority} />
      </span>
    </div>
  );
}
