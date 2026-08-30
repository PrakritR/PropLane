"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { usePortalSession } from "@/hooks/use-portal-session";
import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import { compactTaskLocationLabel, taskNotesPreview } from "@/lib/manager-task-display";
import {
  VENDOR_TASK_LIST_TAB_LABELS,
  VENDOR_TASK_LIST_TABS,
  managerTaskListHref,
  type VendorTaskListTabId,
} from "@/lib/portal-detail-routes";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  fetchVendorAssignedTasks,
  updateVendorAssignedTask,
  VENDOR_TASKS_EVENT,
  type VendorAssignedTask,
} from "@/lib/vendor-tasks.client";
import { isDemoModeActive } from "@/lib/demo/demo-session";

function formatTaskSchedule(task: VendorAssignedTask): string {
  if (task.start && task.end) return formatRangeLabel(task.start, task.end);
  if (task.start) return formatPacificDateTime(task.start);
  if (task.dueDate) return `Due ${formatPacificDateTime(task.dueDate)}`;
  return "No schedule or due date";
}

function TaskNotesSnippet({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);
  const { preview, truncated } = taskNotesPreview(notes);
  if (!notes.trim()) return null;
  return (
    <div className="mt-1">
      <p className={`text-sm text-muted ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}>
        {expanded ? notes : preview}
      </p>
      {truncated ? (
        <button
          type="button"
          className="mt-1 text-xs font-semibold text-primary"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function VendorTaskList({
  tabId: serverTabId,
  basePath = "/vendor",
}: {
  tabId: VendorTaskListTabId;
  basePath?: string;
}) {
  const tabId = useShallowTabId(serverTabId, VENDOR_TASK_LIST_TABS);
  const { showToast } = useAppUi();
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [tasks, setTasks] = useState<VendorAssignedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const rows = await fetchVendorAssignedTasks(userId);
      setTasks(rows);
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
      void fetchVendorAssignedTasks(userId).then(setTasks).catch(() => undefined);
    };
    window.addEventListener(VENDOR_TASKS_EVENT, onChange);
    return () => window.removeEventListener(VENDOR_TASKS_EVENT, onChange);
  }, [userId]);

  useEffect(() => {
    setSelectedIds([]);
  }, [tabId]);

  const openTasks = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);
  const visibleTasks = tabId === "completed" ? doneTasks : openTasks;

  const taskKey = (task: VendorAssignedTask) => `${task.managerUserId}:${task.id}`;

  const selectedTasks = useMemo(
    () => visibleTasks.filter((task) => selectedIds.includes(taskKey(task))),
    [visibleTasks, selectedIds],
  );

  const tabItems = useMemo(
    () =>
      VENDOR_TASK_LIST_TABS.map((id) => ({
        id,
        label: VENDOR_TASK_LIST_TAB_LABELS[id],
        href: managerTaskListHref(basePath, id),
        count: id === "completed" ? doneTasks.length : openTasks.length,
        dataAttr: `vendor-task-list-tab-${id}`,
      })),
    [basePath, doneTasks.length, openTasks.length],
  );

  async function bulkComplete(rows: VendorAssignedTask[]) {
    if (!userId || rows.length === 0) return;
    const target = !rows[0]!.completed;
    let done = 0;
    for (const task of rows) {
      try {
        await updateVendorAssignedTask(userId, {
          managerUserId: task.managerUserId,
          taskId: task.id,
          completed: target,
        });
        done += 1;
      } catch {
        // Report partial success below.
      }
    }
    setSelectedIds([]);
    await refresh();
    showToast(
      done === rows.length
        ? target
          ? `Marked ${done} completed.`
          : `Reopened ${done}.`
        : `Updated ${done} of ${rows.length}.`,
    );
  }

  if (!demo && !ready) {
    return (
      <ManagerPortalPageShell title="Tasks" hideTitleOnMobileNav>
        <p className="text-sm text-muted">Loading…</p>
      </ManagerPortalPageShell>
    );
  }

  if (!demo && !userId) {
    return (
      <ManagerPortalPageShell title="Tasks" hideTitleOnMobileNav>
        <p className="text-sm text-muted">Sign in to view assigned tasks.</p>
      </ManagerPortalPageShell>
    );
  }

  return (
    <ManagerPortalPageShell title="Tasks" hideTitleOnMobileNav>
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
        {!loading && visibleTasks.length === 0 ? (
          <p className="text-sm text-muted">
            {tabId === "completed" ? "No completed tasks yet." : "No tasks assigned to you right now."}
          </p>
        ) : null}
        {!loading && visibleTasks.length > 0 ? (
          <ul
            className={`divide-y divide-border rounded-2xl border border-border bg-card ${tabId === "completed" ? "opacity-80" : ""}`}
          >
            {visibleTasks.map((task) => {
              const key = taskKey(task);
              const location = compactTaskLocationLabel(task);
              return (
                <li key={key} className="flex items-start gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedIds.includes(key)}
                    aria-label={`Select ${task.title}`}
                    onChange={(event) =>
                      setSelectedIds((prev) =>
                        event.target.checked ? [...prev, key] : prev.filter((id) => id !== key),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`font-semibold text-foreground ${tabId === "completed" ? "line-through" : ""}`}>
                      {task.title}
                    </p>
                    <p className="text-sm text-muted">{formatTaskSchedule(task)}</p>
                    {location ? <p className="text-xs text-muted">{location}</p> : null}
                    {task.notes ? <TaskNotesSnippet notes={task.notes} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {selectedTasks.length > 0 ? (
        <PortalPageFooterActions pinned>
          <Button type="button" variant="secondary" onClick={() => void bulkComplete(selectedTasks)}>
            {tabId === "completed" ? "Mark open" : "Mark completed"}
          </Button>
        </PortalPageFooterActions>
      ) : null}
    </ManagerPortalPageShell>
  );
}
