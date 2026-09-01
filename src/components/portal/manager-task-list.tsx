"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { DataList } from "@/components/ui/data-list";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerTaskFormModal } from "@/components/portal/manager-task-form-modal";
import { ManagerTaskFilterFields } from "@/components/portal/manager-task-filter-fields";
import { ManagerCommunicationComposeModal } from "@/components/portal/manager-communication-compose-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { formatRangeLabel, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  compareManagerTaskListRows,
  compactTaskLocationLabel,
  openTasksForListTab,
  serviceRequestLocationLabel,
  serviceRequestsAssignedToViewer,
  taskListRowMatchesFilter,
  type ManagerTaskListFilterId,
  type ManagerTaskListSortId,
} from "@/lib/manager-task-display";
import {
  MANAGER_TASKS_EVENT,
  MANAGER_TASK_PRIORITY_LABELS,
  MANAGER_TASK_URGENCY_LABELS,
  fetchManagerTasks,
  inferManagerTaskUrgency,
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
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  SERVICE_REQUESTS_EVENT,
  syncServiceRequestsFromServer,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { cn } from "@/lib/utils";
import {
  clusterPortalListRows,
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  isPropertyClusterList,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import type { ResidentIdentityFields, PropertyClusterFields } from "@/lib/resident-row-clustering";

function formatTaskSchedule(task: ManagerTask): string {
  if (task.start && task.end) return formatRangeLabel(task.start, task.end);
  if (task.start) return formatPacificDateTime(task.start);
  if (task.dueDate) return `Due ${formatPacificDateTime(task.dueDate)}`;
  return "No schedule or due date";
}

function formatTaskAssignee(task: ManagerTask): string | null {
  const name = task.assignee?.name?.trim();
  if (!name) return task.assignee ? "Assigned" : null;
  return `Assigned to ${name}`;
}

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

function taskRowMetaLine(task: ManagerTask): string {
  const parts: string[] = [];
  const location = compactTaskLocationLabel(task);
  if (location) parts.push(location);
  const schedule = formatTaskSchedule(task);
  if (schedule && schedule !== "No schedule or due date") parts.push(schedule);
  const assigneeLabel = formatTaskAssignee(task);
  if (assigneeLabel) parts.push(assigneeLabel);
  return parts.join(" · ");
}

function taskRowTrailing(task: ManagerTask) {
  return (
    <span className="flex items-center gap-1.5">
      <ManagerTaskUrgencyBadge task={task} />
      <ManagerTaskPriorityBadge priority={task.priority} />
    </span>
  );
}

/**
 * Timing and priority read at a glance on the list, not only inside the edit
 * modal — the point of recording them is that someone scanning the queue can
 * tell what must happen now from what merely has a date.
 */
function ManagerTaskUrgencyBadge({ task }: { task: ManagerTask }) {
  const urgency = inferManagerTaskUrgency(task);
  // Scheduled rows already print their slot; "as needed" tasks carry no timing
  // label on the list — only deadlines get a badge.
  if (urgency === "scheduled" || urgency === "urgent") return null;
  return (
    <span
      className="rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted"
      data-attr={`manager-task-urgency-${urgency}`}
    >
      {MANAGER_TASK_URGENCY_LABELS[urgency]}
    </span>
  );
}

function ManagerTaskPriorityBadge({ priority }: { priority?: ManagerTaskPriority }) {
  // Medium is the default, so badging it adds noise to every row without
  // telling the reader anything.
  if (!priority || priority === "medium") return null;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        priority === "high" ? "border-danger/30 text-danger" : "border-border text-muted"
      }`}
      data-attr={`manager-task-priority-${priority}`}
    >
      {MANAGER_TASK_PRIORITY_LABELS[priority]}
    </span>
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
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [listFilter, setListFilter] = useState<ManagerTaskListFilterId>("all");
  const [sortId, setSortId] = useState<ManagerTaskListSortId>("due_soonest");
  const [completingTaskIds, setCompletingTaskIds] = useState<Set<string>>(() => new Set());

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
    (propertyId?: string) => !propertyFilterId || propertyId === propertyFilterId,
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
      .sort((a, b) => compareManagerTaskListRows(a, b, sortId, propertyLabelForId));
  }, [
    assignedServices,
    doneTasks,
    inProgressTasks,
    listFilter,
    matchesProperty,
    overdueTasks,
    propertyLabelForId,
    sortId,
    tabId,
  ]);

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
      sortId !== "due_soonest" ? sortId : "",
    ]);

  const taskFilterFieldCount = (propertyOptions.length > 1 ? 1 : 0) + 3;

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
        setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
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

  async function toggleTaskCompleted(task: ManagerTask, completed: boolean) {
    if (!userId || completingTaskIds.has(task.id)) return;
    setCompletingTaskIds((prev) => new Set(prev).add(task.id));
    try {
      await updateManagerTask(userId, task.id, { completed });
      setTasks((prev) => prev.map((row) => (row.id === task.id ? { ...row, completed } : row)));
      showToast(completed ? "Task completed." : "Task reopened.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update task.");
    } finally {
      setCompletingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  const taskListColumns = [
    { id: "task", header: "Task", cell: (row: TaskListRow) => (row.kind === "task" ? row.task.title : row.request.offerName) },
    { id: "meta", header: "Details", cell: (row: TaskListRow) => (row.kind === "task" ? taskRowMetaLine(row.task) : serviceRequestLocationLabel(row.request) ?? "") },
  ] as const;

  const renderTaskDataList = (rows: TaskListClusterRow[]) => (
    <DataList
      hideColumnHeaders
      selectable
      rows={rows.map((row) => {
        if (row.kind === "task") {
          const task = row.task;
          return {
            id: task.id,
            data: row,
            primary: task.title,
            meta: taskRowMetaLine(task) || undefined,
            trailing: taskRowTrailing(task),
            selected: task.completed,
            onSelectedChange: (checked) => {
              void toggleTaskCompleted(task, checked);
            },
            onClick: () => beginEdit(task),
          };
        }
        const request = row.request;
        const bucket = serviceRequestBucket(request);
        const rowId = `service-${request.id}`;
        const location = serviceRequestLocationLabel(request);
        return {
          id: rowId,
          data: row,
          primary: request.offerName,
          meta: [location, request.status].filter(Boolean).join(" · ") || undefined,
          trailing: (
            <Badge tone="info">Service</Badge>
          ),
          inlineAction: (
            <Link
              href={serviceRequestDetailHref(basePath, bucket, request.id)}
              className="text-xs font-semibold text-primary"
              data-attr="manager-task-list-service-link"
              onClick={(event) => event.stopPropagation()}
            >
              Open
            </Link>
          ),
        };
      })}
      columns={[...taskListColumns]}
    />
  );

  function renderTaskClusters(
    clusters: ReturnType<typeof clusterPortalListRows<TaskListClusterRow>>,
  ) {
    const clusterCountLabel = (count: number) =>
      count === 1 ? "1 task" : `${count} tasks`;

    if (isPropertyClusterList(groupMode, clusters)) {
      return clusters.map((cluster) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">{cluster.propertyLabel}</span>
              <Badge tone="info">{clusterCountLabel(cluster.rows.length)}</Badge>
            </>
          }
        >
          {renderTaskDataList(cluster.rows)}
        </ApplicationHouseholdCluster>
      ));
    }

    return clusters.map((cluster) => (
      <ApplicationHouseholdCluster
        key={cluster.key}
        header={
          <>
            <span className="truncate text-xs font-semibold text-foreground">{cluster.residentLabel}</span>
            {cluster.residentEmail &&
            cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
              <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
            ) : null}
            {cluster.propertyLabel ? (
              <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
            ) : null}
            <Badge tone="info">{clusterCountLabel(cluster.rows.length)}</Badge>
          </>
        }
      >
        {renderTaskDataList(cluster.rows)}
      </ApplicationHouseholdCluster>
    ));
  }

  function openAddTask() {
    setEditingId(null);
    setAddOpen(true);
  }

  const renderAddTaskRow = (className?: string) =>
    tabId === "in-progress" ? (
      <div className={className ?? PORTAL_LIST_ADD_ROW_WRAP_CLASS} data-testid="tasks-list-add">
        <PortalListAddRow
          label="Add"
          ariaLabel="Add task"
          icon={PORTAL_LIST_ADD_ICONS.request}
          onClick={openAddTask}
          dataAttr="manager-task-list-add"
        />
      </div>
    ) : null;

  return (
    <ManagerPortalPageShell
      title="Tasks"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={tabItems}
        activeDestinationId={tabId}
        destinationAriaLabel="Task status"
        actions={
          <>
            {tasksFilterSheet}
            <Button
              type="button"
              variant="outline"
              className={PORTAL_COMMAND_ACTION_BTN}
              data-attr="manager-task-automation-open"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </Button>
            {tabId === "in-progress" ? (
              <Button
                type="button"
                className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
                style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
                data-attr="manager-task-list-header-add"
                onClick={openAddTask}
              >
                Add
              </Button>
            ) : null}
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
            {renderAddTaskRow()}
          </>
        ) : null}

        {!loading && visibleRows.length === 0
          ? renderAddTaskRow(`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} pt-5 sm:pt-6`)
          : null}
      </div>

      {userId ? (
        <ManagerTaskFormModal
          open={addOpen}
          onClose={() => {
            setAddOpen(false);
            setEditingId(null);
          }}
          managerUserId={userId}
          editingId={editingId}
          propertyTick={propertyTick}
          onSaved={async (prefill) => {
            await refresh();
            showToast(editingId ? "Task updated." : "Task saved.");
            if (prefill) {
              setComposeDraft(prefill);
              setComposeOpen(true);
            }
          }}
        />
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
