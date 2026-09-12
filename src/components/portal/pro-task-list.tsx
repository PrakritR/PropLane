"use client";

import { workspaceContainsProperty } from "@/lib/workspaces/selection";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PORTAL_PAGE_PRIMARY_ACTION_BTN } from "@/components/portal/portal-icon-action";
import { Settings2 } from "lucide-react";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerTaskFormModal } from "@/components/portal/pro-task-form-modal";
import { ManagerTaskFilterFields } from "@/components/portal/pro-task-filter-fields";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { TaskTableHeader, TaskTableRow, taskDueState, type TaskDueState } from "@/components/portal/pro-task-row";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { ManagerCommunicationComposeModal } from "@/components/portal/pro-communication-compose-modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { formatRangeLabel, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  MANAGER_TASK_LIST_FILTER_LABELS,
  compareManagerTaskListRows,
  compactTaskLocationLabel,
  openTasksForListTab,
  serviceRequestLocationLabel,
  serviceRequestsAssignedToViewer,
  taskListRowMatchesFilter,
  type ManagerTaskListFilterId,
  type ManagerTaskListSortId,
} from "@/lib/manager-task-display";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  MANAGER_TASKS_EVENT,
  MANAGER_TASK_PRIORITY_LABELS,
  deleteManagerTask,
  fetchManagerTasks,
  updateManagerTask,
  type ManagerTask,
  type ManagerTaskPriority,
} from "@/lib/manager-tasks";
import {
  MANAGER_TASK_LIST_TAB_LABELS,
  MANAGER_TASK_LIST_TABS,
  managerTaskListHref,
  serviceRequestDetailHref,
  type ManagerTaskListTabId,
} from "@/lib/portal-detail-routes";
import {
  SERVICE_REQUESTS_EVENT,
  syncServiceRequestsFromServer,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { cn } from "@/lib/utils";
import {
  clusterPortalListRows,
  isPropertyClusterList,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import type { ResidentIdentityFields, PropertyClusterFields } from "@/lib/resident-row-clustering";



type TaskListRow =
  | { kind: "task"; id: string; task: ManagerTask }
  | { kind: "service"; id: string; request: ServiceRequest };

type TaskListClusterRow = TaskListRow & ResidentIdentityFields & PropertyClusterFields;

function taskListRowClusterFields(
  row: TaskListRow,
  propertyLabelForId: (propertyId?: string) => string,
): TaskListClusterRow {
  if (row.kind === "task") {
    return {
      ...row,
      residentName: row.task.assignee?.name ?? "",
      // A WorkAssignee is a type/id/name snapshot and carries no email, so the
      // cluster key falls back to the assignee's name — which is the intended
      // grouping here ("who is this on") rather than a resident identity.
      residentEmail: "",
      propertyId: row.task.propertyId,
      propertyLabel: row.task.propertyTitle ?? propertyLabelForId(row.task.propertyId),
    };
  }
  return {
    ...row,
    residentName: row.request.residentName,
    residentEmail: row.request.residentEmail,
    propertyId: row.request.propertyId,
    propertyLabel: propertyLabelForId(row.request.propertyId),
  };
}

function serviceRequestBucket(req: ServiceRequest): "pending" | "approved" | "denied" {
  if (req.status === "approved") return "approved";
  if (req.status === "denied") return "denied";
  return "pending";
}

/**
 * The line under a task's title. The due date and the assignee have their own
 * columns now, so this carries only what the columns do not: where, a
 * scheduled slot (a range, not a bare due date), checklist progress,
 * recurrence, comments.
 */
function taskRowMetaLine(task: ManagerTask): string {
  const parts: string[] = [];
  const location = compactTaskLocationLabel(task);
  if (location) parts.push(location);
  if (task.start && task.end) parts.push(formatRangeLabel(task.start, task.end));
  if (task.checklist?.length) {
    parts.push(`${task.checklist.filter((item) => item.done).length}/${task.checklist.length} steps`);
  }
  if (task.recurrence && task.recurrence !== "none") {
    parts.push(task.recurrence === "daily" ? "Repeats daily" : task.recurrence === "weekly" ? "Repeats weekly" : "Repeats monthly");
  }
  if (task.comments?.length) parts.push(`${task.comments.length} ${task.comments.length === 1 ? "comment" : "comments"}`);
  return parts.join(" · ");
}

type TaskGroupMode = "property" | "assignee" | "due";

const TASK_GROUP_LABELS: Record<TaskGroupMode, string> = {
  property: "Property",
  assignee: "Assignee",
  due: "Due",
};

/** "Group by ▾" in the toolbar — the one control that reshapes the list. */
function TaskGroupBySelect({ value, onChange }: { value: TaskGroupMode; onChange: (next: TaskGroupMode) => void }) {
  return (
    <label className="relative inline-flex h-9 shrink-0 items-center rounded-full border border-border bg-card pl-3 pr-7 text-[12.5px] font-semibold text-foreground">
      <span className="sr-only">Group by</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TaskGroupMode)}
        aria-label="Group by"
        data-attr="manager-task-group-by"
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {(Object.keys(TASK_GROUP_LABELS) as TaskGroupMode[]).map((k) => (
          <option key={k} value={k}>
            Group by {TASK_GROUP_LABELS[k]}
          </option>
        ))}
      </select>
      <span aria-hidden>
        <span className="text-muted">Group by </span>
        {TASK_GROUP_LABELS[value]}
      </span>
      <span aria-hidden className="pointer-events-none absolute right-2.5 text-muted">
        ▾
      </span>
    </label>
  );
}

export function ManagerTaskList({
  tabId: serverTabId,
  basePath = "/portal",
}: {
  tabId: ManagerTaskListTabId;
  basePath?: string;
}) {
  const tabId = useShallowTabId(serverTabId, MANAGER_TASK_LIST_TABS);
  const { showToast } = useAppUi();
  const { userId, email: managerEmail, ready } = useManagerUserId();
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [assignedServices, setAssignedServices] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilterId, setPropertyFilterId] = useState("");
  /*
   * Group by — Property (default) · Assignee · Due — lives in the URL
   * (`?group=`) so a grouping survives a reload and can be shared. `house` and
   * `resident` are the shared list-grouping modes (resident = assignee here);
   * `due` buckets rows by deadline and is this list's own.
   */
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const groupParam = searchParams?.get("group");
  const taskGroupMode: TaskGroupMode =
    groupParam === "assignee" ? "assignee" : groupParam === "due" ? "due" : "property";
  const setTaskGroupMode = useCallback(
    (next: TaskGroupMode) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "property") params.delete("group");
      else params.set("group", next);
      const query = params.toString();
      window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
    },
    [pathname, searchParams],
  );
  const groupMode: PortalListGroupMode = taskGroupMode === "assignee" ? "resident" : "house";
  const setGroupMode = useCallback(
    (next: PortalListGroupMode) => setTaskGroupMode(next === "resident" ? "assignee" : "property"),
    [setTaskGroupMode],
  );
  const [assigneeFilterId, setAssigneeFilterId] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<ManagerTaskPriority | "">("");
  // Frozen per mount: the due chips only need "today" to be right, and a
  // minute-level clock would re-render every row for nothing.
  const [nowMs] = useState(() => Date.now());
  const [listFilter, setListFilter] = useState<ManagerTaskListFilterId>("all");
  const [sortId, setSortId] = useState<ManagerTaskListSortId>("due_soonest");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(tabId);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      await syncScheduleRecordsFromServer({ force: true });
      await syncServiceRequestsFromServer({ force: true });
      const rows = await fetchManagerTasks(userId);
      setTasks(rows);
      setAssignedServices(serviceRequestsAssignedToViewer(userId));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load tasks.");
    } finally {
      setLoading(false);
    }
  }, [showToast, userId]);

  useEffect(() => {
    if (!ready) return;
    if (!userId) {
      setLoading(false);
      return;
    }
    void syncPropertyPipelineFromServer()
      .then(() => setPropertyTick((n) => n + 1))
      .catch(() => undefined);
    void refresh();
  }, [ready, userId, refresh]);

  useEffect(() => {
    const onChange = () => {
      if (!userId) return;
      void fetchManagerTasks(userId).then(setTasks).catch(() => undefined);
      setAssignedServices(serviceRequestsAssignedToViewer(userId));
    };
    window.addEventListener(MANAGER_TASKS_EVENT, onChange);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onChange);
    return () => {
      window.removeEventListener(MANAGER_TASKS_EVENT, onChange);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onChange);
    };
  }, [userId]);

  const [editingId, setEditingId] = useState<string | null>(null);

  const overdueTasks = useMemo(() => openTasksForListTab(tasks, "overdue"), [tasks]);
  const inProgressTasks = useMemo(
    () => openTasksForListTab(tasks, "in-progress"),
    [tasks],
  );
  const doneTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);

  const matchesProperty = useCallback(
    (propertyId?: string) => workspaceContainsProperty(propertyId) && (!propertyFilterId || propertyId === propertyFilterId),
    [propertyFilterId],
  );

  const propertyLabelForId = useCallback(
    (propertyId?: string) =>
      propertyId ? (propertyOptions.find((option) => option.id === propertyId)?.label ?? "") : "",
    [propertyOptions],
  );

  const visibleRows = useMemo((): TaskListRow[] => {
    const taskSource =
      tabId === "completed" ? doneTasks : tabId === "overdue" ? overdueTasks : inProgressTasks;
    const taskRows: TaskListRow[] = taskSource
      .filter((task) => matchesProperty(task.propertyId))
      .map((task) => ({ kind: "task", id: task.id, task }));
    const serviceRows: TaskListRow[] =
      tabId === "in-progress"
        ? assignedServices
            .filter((req) => matchesProperty(req.propertyId))
            .map((request) => ({ kind: "service", id: `service-${request.id}`, request }))
        : [];
    return [...taskRows, ...serviceRows]
      .filter((row) => taskListRowMatchesFilter(row, listFilter))
      .filter((row) => {
        if (row.kind !== "task") return !assigneeFilterId && !priorityFilter;
        if (assigneeFilterId && (row.task.assignee?.id ?? "") !== assigneeFilterId) return false;
        if (priorityFilter && (row.task.priority ?? "medium") !== priorityFilter) return false;
        return true;
      })
      .sort((a, b) => compareManagerTaskListRows(a, b, sortId, propertyLabelForId));
  }, [
    assignedServices,
    assigneeFilterId,
    doneTasks,
    inProgressTasks,
    listFilter,
    matchesProperty,
    overdueTasks,
    priorityFilter,
    propertyLabelForId,
    sortId,
    tabId,
  ]);

  /** Everyone a task on this list is on, for the Assignee filter. */
  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) {
      const id = task.assignee?.id?.trim();
      const name = task.assignee?.name?.trim();
      if (id && name && !seen.has(id)) seen.set(id, name);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [tasks]);

  const activeFilterChips: PortalActiveFilterChip[] = [
    ...(propertyFilterId
      ? [{ id: "property", label: propertyLabelForId(propertyFilterId) || "Property", onRemove: () => setPropertyFilterId("") }]
      : []),
    ...(assigneeFilterId
      ? [
          {
            id: "assignee",
            label: assigneeOptions.find((o) => o.id === assigneeFilterId)?.label ?? "Assignee",
            onRemove: () => setAssigneeFilterId(""),
          },
        ]
      : []),
    ...(priorityFilter
      ? [{ id: "priority", label: `${priorityFilter === "medium" ? "Normal" : MANAGER_TASK_PRIORITY_LABELS[priorityFilter]} priority`, onRemove: () => setPriorityFilter("") }]
      : []),
    ...(listFilter !== "all"
      ? [{ id: "type", label: MANAGER_TASK_LIST_FILTER_LABELS[listFilter], onRemove: () => setListFilter("all") }]
      : []),
  ];

  const clusters = useMemo(
    () =>
      clusterPortalListRows(
        visibleRows.map((row) => taskListRowClusterFields(row, propertyLabelForId)),
        groupMode,
        (row) => row.propertyLabel,
      ),
    [groupMode, propertyLabelForId, visibleRows],
  );

  const taskFilterActiveCount =
    portalFilterActiveCount([
      listFilter !== "all" ? listFilter : "",
      propertyFilterId,
      assigneeFilterId,
      priorityFilter,
      sortId !== "due_soonest" ? sortId : "",
    ]);

  const taskFilterFieldCount = (propertyOptions.length > 1 ? 1 : 0) + 5;

  const tasksFilterSheet = (
    <PortalFilterSortSheet
      activeCount={taskFilterActiveCount}
      compactPanel
      commandStripTrigger
      filterFieldCount={taskFilterFieldCount}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setListFilter("all");
        setPropertyFilterId("");
        setAssigneeFilterId("");
        setPriorityFilter("");
        setTaskGroupMode("property");
        setSortId("due_soonest");
      }}
      dataAttr="tasks-filter-sheet-open"
    >
      <ManagerTaskFilterFields
        listFilter={listFilter}
        onListFilterChange={setListFilter}
        tabId={tabId}
        propertyOptions={propertyOptions}
        propertyFilterId={propertyFilterId}
        onPropertyFilterIdChange={setPropertyFilterId}
        assigneeOptions={assigneeOptions}
        assigneeFilterId={assigneeFilterId}
        onAssigneeFilterIdChange={setAssigneeFilterId}
        priorityFilter={priorityFilter}
        onPriorityFilterChange={setPriorityFilter}
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        sortId={sortId}
        onSortIdChange={setSortId}
      />
    </PortalFilterSortSheet>
  );

  useEffect(() => {
    if (tabId !== "in-progress" && listFilter === "service_orders") {
      setListFilter("all");
    }
  }, [listFilter, tabId]);

  const tabItems = useMemo(() => {
    const serviceCount = assignedServices.filter((req) => matchesProperty(req.propertyId)).length;
    const inProgressCount =
      inProgressTasks.filter((task) => matchesProperty(task.propertyId)).length + serviceCount;
    const overdueCount = overdueTasks.filter((task) => matchesProperty(task.propertyId)).length;
    const completedCount = doneTasks.filter((task) => matchesProperty(task.propertyId)).length;

    return MANAGER_TASK_LIST_TABS.map((id) => ({
      id,
      label: MANAGER_TASK_LIST_TAB_LABELS[id],
      href: managerTaskListHref(basePath, id),
      count:
        id === "completed"
          ? completedCount
          : id === "overdue"
            ? overdueCount
            : inProgressCount,
      alert: id === "overdue" && overdueCount > 0,
      dataAttr: `manager-task-list-tab-${id}`,
    }));
  }, [
    assignedServices,
    basePath,
    doneTasks,
    inProgressTasks,
    matchesProperty,
    overdueTasks,
  ]);

  function beginEdit(task: ManagerTask) {
    setEditingId(task.id);
    setAddOpen(true);
  }

  const selectedTaskIds = useMemo(
    () => [...selectedIds].filter((id) => !id.startsWith("service-")),
    [selectedIds],
  );

  const editSelectedTask = useCallback(() => {
    const taskId = selectedTaskIds[0];
    if (!taskId) return;
    const task = tasks.find((row) => row.id === taskId);
    if (!task) return;
    clearSelection();
    beginEdit(task);
  }, [clearSelection, selectedTaskIds, tasks]);

  const bulkSetCompleted = useCallback(
    async (completed: boolean) => {
      if (!userId || selectedTaskIds.length === 0 || bulkBusy) return;
      setBulkBusy(true);
      try {
        for (const taskId of selectedTaskIds) {
          await updateManagerTask(userId, taskId, { completed });
        }
        setTasks((prev) =>
          prev.map((row) =>
            selectedTaskIds.includes(row.id) ? { ...row, completed } : row,
          ),
        );
        showToast(
          completed
            ? selectedTaskIds.length === 1
              ? "Task completed."
              : `${selectedTaskIds.length} tasks completed.`
            : selectedTaskIds.length === 1
              ? "Task reopened."
              : `${selectedTaskIds.length} tasks reopened.`,
        );
        clearSelection();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not update tasks.");
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, clearSelection, selectedTaskIds, showToast, userId],
  );

  const bulkDeleteTasks = useCallback(async () => {
    if (!userId || selectedTaskIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      for (const taskId of selectedTaskIds) {
        await deleteManagerTask(userId, taskId);
      }
      setTasks((prev) => prev.filter((row) => !selectedTaskIds.includes(row.id)));
      showToast(
        selectedTaskIds.length === 1
          ? "Task deleted."
          : `${selectedTaskIds.length} tasks deleted.`,
      );
      clearSelection();
      setDeleteConfirmOpen(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete tasks.");
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, clearSelection, selectedTaskIds, showToast, userId]);

  const bulkSelectionActions = useMemo((): PortalAdaptiveAction[] => {
    const actions: PortalAdaptiveAction[] = [];

    if (selectedTaskIds.length === 1) {
      actions.push({
        id: "edit",
        node: (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="manager-tasks-bulk-edit"
            disabled={bulkBusy}
            onClick={editSelectedTask}
          >
            Edit
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="manager-tasks-bulk-edit" onSelect={editSelectedTask}>
            Edit
          </DropdownMenuItem>
        ),
      });
    }

    actions.push({
      id: "delete",
      node: (
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
          data-attr="manager-tasks-bulk-delete"
          disabled={bulkBusy}
          onClick={() => setDeleteConfirmOpen(true)}
        >
          Delete
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem
          data-attr="manager-tasks-bulk-delete"
          className="text-danger focus:text-danger"
          onSelect={() => setDeleteConfirmOpen(true)}
        >
          Delete
        </DropdownMenuItem>
      ),
    });

    const completeLabel = tabId === "completed" ? "Reopen" : "Mark done";
    const completeHandler = () => {
      void bulkSetCompleted(tabId !== "completed");
    };
    actions.push({
      id: "complete",
      node: (
        <Button
          type="button"
          variant="primary"
          className={PORTAL_BULK_BAR_BTN}
          data-attr={tabId === "completed" ? "manager-tasks-bulk-reopen" : "manager-tasks-bulk-mark-done"}
          disabled={bulkBusy}
          onClick={completeHandler}
        >
          {completeLabel}
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem
          data-attr={tabId === "completed" ? "manager-tasks-bulk-reopen" : "manager-tasks-bulk-mark-done"}
          onSelect={completeHandler}
        >
          {completeLabel}
        </DropdownMenuItem>
      ),
    });

    return actions;
  }, [bulkBusy, bulkSetCompleted, editSelectedTask, selectedTaskIds.length, tabId]);

  const renderTaskDataList = (rows: TaskListClusterRow[], first = false) => (
    <div className="rounded-xl border border-border bg-card">
      {first ? <TaskTableHeader /> : null}
      {rows.map((row) => {
        if (row.kind === "task") {
          const task = row.task;
          return (
            <TaskTableRow
              key={task.id}
              task={task}
              context={taskRowMetaLine(task) || undefined}
              propertyLabel={task.propertyTitle ?? propertyLabelForId(task.propertyId)}
              showPropertyOnPhone={taskGroupMode !== "property"}
              viewerUserId={userId}
              nowMs={nowMs}
              checked={selectedIds.has(task.id)}
              onSelectedChange={() => toggleSelected(task.id)}
              onOpen={() => beginEdit(task)}
              dataAttr="manager-task-row"
            />
          );
        }
        const request = row.request;
        const bucket = serviceRequestBucket(request);
        const location = serviceRequestLocationLabel(request);
        return (
          <div
            key={`service-${request.id}`}
            className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0"
            data-attr="manager-task-service-row"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-foreground">{request.offerName}</span>
              <span className="block truncate text-[12px] text-muted">
                {[location, request.status].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Badge tone="info">Service</Badge>
            <Link
              href={serviceRequestDetailHref(basePath, bucket, request.id)}
              className="text-xs font-semibold text-primary"
              data-attr="manager-task-list-service-link"
            >
              Open
            </Link>
          </div>
        );
      })}
    </div>
  );

  /** Overdue · Today · This week · Later · No date — the Due grouping. */
  const dueClusters = useMemo(() => {
    const order: Array<{ key: TaskDueState; label: string }> = [
      { key: "overdue", label: "Overdue" },
      { key: "today", label: "Today" },
      { key: "soon", label: "This week" },
      { key: "later", label: "Later" },
      { key: "none", label: "No date" },
      { key: "done", label: "Done" },
    ];
    const buckets = new Map<TaskDueState, TaskListClusterRow[]>();
    for (const row of clusters.flatMap((c) => c.rows)) {
      const state = row.kind === "task" ? taskDueState(row.task, nowMs) : "none";
      buckets.set(state, [...(buckets.get(state) ?? []), row]);
    }
    return order.filter((o) => buckets.has(o.key)).map((o) => ({ key: o.key, label: o.label, rows: buckets.get(o.key)! }));
  }, [clusters, nowMs]);

  function renderTaskClusters(
    clusters: ReturnType<typeof clusterPortalListRows<TaskListClusterRow>>,
  ) {
    const clusterCountLabel = (count: number) =>
      count === 1 ? "1 task" : `${count} tasks`;

    if (taskGroupMode === "due") {
      return dueClusters.map((cluster, i) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">{cluster.label}</span>
              <span className="sr-only">{clusterCountLabel(cluster.rows.length)}</span>
            </>
          }
        >
          {renderTaskDataList(cluster.rows, i === 0)}
        </ApplicationHouseholdCluster>
      ));
    }

    if (isPropertyClusterList(groupMode, clusters)) {
      return clusters.map((cluster, i) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">{cluster.propertyLabel || "No property"}</span>
              <span className="sr-only">{clusterCountLabel(cluster.rows.length)}</span>
            </>
          }
        >
          {renderTaskDataList(cluster.rows, i === 0)}
        </ApplicationHouseholdCluster>
      ));
    }

    return clusters.map((cluster, i) => (
      <ApplicationHouseholdCluster
        key={cluster.key}
        header={
          <>
            <span className="truncate text-xs font-semibold text-foreground">{cluster.residentLabel || "Unassigned"}</span>
            {cluster.residentEmail &&
            cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
              <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
            ) : null}
            {cluster.propertyLabel ? (
              <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
            ) : null}
            <span className="sr-only">{clusterCountLabel(cluster.rows.length)}</span>
          </>
        }
      >
        {renderTaskDataList(cluster.rows, i === 0)}
      </ApplicationHouseholdCluster>
    ));
  }

  function openAddTask() {
    setEditingId(null);
    setAddOpen(true);
  }

  return (
    <ManagerPortalPageShell
      title="Tasks"
      subtitle="What needs doing, who owns it, and when it is due."
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
      primaryAction={
        <Button
          type="button"
          className={PORTAL_PAGE_PRIMARY_ACTION_BTN}
          data-attr="manager-task-add-top"
          onClick={openAddTask}
        >
          + Add task
        </Button>
      }
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={tabItems}
        activeDestinationId={tabId}
        destinationAriaLabel="Task status"
        activeFilterChips={activeFilterChips.length > 0 ? <PortalActiveFilterChips chips={activeFilterChips} /> : undefined}
        actions={
          <>
            <TaskGroupBySelect value={taskGroupMode} onChange={setTaskGroupMode} />
            {tasksFilterSheet}
            <PortalIconAction
              icon={Settings2}
              label="Task settings"
              data-attr="manager-task-automation-open"
              onClick={() => setSettingsOpen(true)}
            />
          </>
        }
      />

      <div className={PORTAL_LIST_PAGE_BODY}>
        {loading ? <p className="text-sm text-muted">Loading…</p> : null}

        {!loading && visibleRows.length > 0 ? (
          <>
            <div
              className={cn("space-y-3", tabId === "completed" && "opacity-80")}
              data-attr="manager-task-groups"
            >
              {renderTaskClusters(clusters)}
            </div>
          </>
        ) : null}

        {!loading && visibleRows.length === 0 ? (
          <PortalListEmptyCard
            title={
              activeFilterChips.length > 0
                ? "No tasks match these filters"
                : tabId === "overdue"
                  ? "Nothing overdue"
                  : tabId === "completed"
                    ? "Nothing done yet"
                    : "No open tasks"
            }
            description={
              activeFilterChips.length > 0
                ? "Clear a filter to see the rest."
                : tabId === "overdue"
                  ? "A task whose due date has passed lands here until it is done."
                  : tabId === "completed"
                    ? "Tasks you mark done move here, so nothing is lost."
                    : "What needs doing, who owns it and when it is due — add the first one."
            }
            sibling={(() => {
              const other = tabItems.find((t) => t.id !== tabId && t.count > 0);
              return other
                ? { label: `${other.count} ${other.label.toLowerCase()} · open ${other.label}`, href: other.href, dataAttr: `manager-task-empty-sibling-${other.id}` }
                : null;
            })()}
            actions={
              activeFilterChips.length > 0
                ? [
                    {
                      label: "Clear filters",
                      onClick: () => {
                        setListFilter("all");
                        setPropertyFilterId("");
                        setAssigneeFilterId("");
                        setPriorityFilter("");
                      },
                      dataAttr: "manager-task-empty-clear-filters",
                    },
                  ]
                : tabId === "in-progress"
                  ? [{ label: "Add task", onClick: openAddTask, dataAttr: "manager-task-list-add" }]
                  : []
            }
            dataAttr="manager-task-empty"
          />
        ) : null}
      </div>

      {userId ? (
        <ManagerTaskFormModal
          open={addOpen}
          onClose={() => {
            setAddOpen(false);
            setEditingId(null);
            clearSelection();
          }}
          managerUserId={userId}
          editingId={editingId}
          propertyTick={propertyTick}
          onSaved={async (prefill) => {
            clearSelection();
            await refresh();
            showToast(editingId ? "Task updated." : "Task saved.");
            if (prefill) {
              setComposeDraft(prefill);
              setComposeOpen(true);
            }
          }}
        />
      ) : null}

      <ConfirmDeleteModal
        open={deleteConfirmOpen}
        title={selectedTaskIds.length === 1 ? "Delete task?" : `Delete ${selectedTaskIds.length} tasks?`}
        description={
          selectedTaskIds.length === 1
            ? "This task will be removed from your list and calendar."
            : `${selectedTaskIds.length} tasks will be removed from your list and calendar.`
        }
        confirmLabel="Delete"
        busy={bulkBusy}
        dataAttr="manager-tasks-bulk-delete-confirm"
        onClose={() => {
          if (!bulkBusy) setDeleteConfirmOpen(false);
        }}
        onConfirm={() => {
          void bulkDeleteTasks();
        }}
      />

      {selectedTaskIds.length > 0 ? (
        <BulkActionBar count={selectedTaskIds.length} hideCount variant="payments">
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </BulkActionBar>
      ) : null}

      <ManagerCommunicationComposeModal
        open={composeOpen}
        onClose={() => {
          setComposeOpen(false);
          setComposeDraft(null);
        }}
        initialDraft={composeDraft}
        senderEmail={managerEmail ?? "manager@example.com"}
        smsUiEnabled={false}
        onSent={() => {
          setComposeOpen(false);
          setComposeDraft(null);
          showToast("Message sent.");
        }}
      />
      <ManagerPortalSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab="tasks"
        scopedTitle="Tasks"
      />
    </ManagerPortalPageShell>
  );
}
