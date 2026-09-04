"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalSession } from "@/hooks/use-portal-session";
import { formatRangeLabel } from "@/lib/demo-admin-scheduling";
import { compactTaskLocationLabel } from "@/lib/manager-task-display";
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
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

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

      {/*
        The house list surface, so Tasks matches every other list in every other
        portal: record rows with a leading checkbox, and a FLOATING dock rather
        than a pinned page footer. A row opens onto the note the manager left,
        which is the thing a vendor reads before setting out.
      */}
      <PortalRecordListSurface
        isEmpty={!loading && visibleTasks.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="service"
            message={
              tabId === "completed" ? "No completed tasks yet." : "No tasks assigned to you right now."
            }
          />
        }
        bulkCount={selectedTasks.length}
        bulkActions={
          selectedTasks.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="vendor-tasks-bulk-complete"
                onClick={() => void bulkComplete(selectedTasks)}
              >
                {tabId === "completed" ? "Mark open" : "Mark completed"}
              </Button>
            </div>
          ) : null
        }
        dataAttr="vendor-tasks-list"
      >
        {loading ? (
          <p className="px-4 py-3 text-sm text-muted">Loading…</p>
        ) : (
          visibleTasks.map((task) => {
            const key = taskKey(task);
            const location = compactTaskLocationLabel(task);
            const open = expandedKey === key;
            return (
              <div key={key}>
                <PortalServiceRecordRow
                  title={task.title}
                  subtitle={[formatTaskSchedule(task), location].filter(Boolean).join(" · ")}
                  selected={open}
                  checked={selectedIds.includes(key)}
                  onSelectedChange={() =>
                    setSelectedIds((prev) =>
                      prev.includes(key) ? prev.filter((id) => id !== key) : [...prev, key],
                    )
                  }
                  onOpen={() => setExpandedKey((cur) => (cur === key ? null : key))}
                  dataAttr="vendor-task-row"
                />
                {open ? (
                  <div className="border-b border-border/50 bg-accent/10 px-4 py-3 text-sm">
                    {task.notes?.trim() ? (
                      <p className="whitespace-pre-wrap leading-relaxed text-foreground">{task.notes.trim()}</p>
                    ) : (
                      <p className="text-muted">No note left with this task.</p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </PortalRecordListSurface>

    </ManagerPortalPageShell>
  );
}
