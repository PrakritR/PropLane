"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DestinationNav } from "@/components/ui/destination-nav";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ApplicationHouseholdCluster, PortalListClusterSelectCheckbox } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { ManagerPortalPageShell, PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE } from "@/components/portal/portal-metrics";
import { ApplicationHouseholdCluster, PortalListClusterSelectCheckbox } from "@/components/portal/application-household-list";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { ManagerTaskFormModal } from "@/components/portal/manager-task-form-modal";
import { ManagerTaskFilterFields } from "@/components/portal/manager-task-filter-fields";
import { ManagerCommunicationComposeModal } from "@/components/portal/manager-communication-compose-modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { formatRangeLabel, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  compactTaskLocationLabel,
  openTasksForListTab,
  serviceRequestLocationLabel,
  serviceRequestsAssignedToViewer,
  taskListRowMatchesFilter,
  taskNotesPreview,
  type ManagerTaskListFilterId,
} from "@/lib/manager-task-display";
import {
  MANAGER_TASKS_EVENT,
  MANAGER_TASK_PRIORITY_LABELS,
  MANAGER_TASK_URGENCY_LABELS,
  deleteManagerTask,
  fetchManagerTasks,
  inferManagerTaskUrgency,
  reapplyManagerTasksToCalendar,
  updateManagerTask,
  type ManagerTask,
  type ManagerTaskPriority,
} from "@/lib/manager-tasks";
import {
  buildManagerTaskReminderPreview,
  resolveTaskAssigneeEmail,
  taskAssigneeRecipientLabel,
} from "@/lib/manager-task-reminder";
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

/** Match payments bulk bar — compact outline pills in one horizontal row on mobile. */
const TASK_BULK_BAR_BTN =
  "h-8 min-h-0 shrink-0 whitespace-nowrap rounded-full border-border px-2.5 text-[10px] font-semibold sm:px-3 sm:text-[11px] !shadow-none hover:!translate-y-0 [html[data-theme=dark]_&]:portal-outline-control";

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

function rowSortKey(row: TaskListRow): string {
  if (row.kind === "task") {
    return row.task.start ?? row.task.dueDate ?? row.task.createdAt;
  }
  return row.request.requestedAt;
}

function serviceRequestBucket(req: ServiceRequest): "pending" | "approved" | "denied" {
  if (req.status === "approved") return "approved";
  if (req.status === "denied") return "denied";
  return "pending";
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

/**
 * Timing and priority read at a glance on the list, not only inside the edit
 * modal — the point of recording them is that someone scanning the queue can
 * tell what must happen now from what merely has a date.
 */
function ManagerTaskUrgencyBadge({ task }: { task: ManagerTask }) {
  const urgency = inferManagerTaskUrgency(task);
  // A scheduled task already prints its slot on the next line, so a badge
  // saying "Scheduled" would just repeat it.
  if (urgency === "scheduled") return null;
  const urgent = urgency === "urgent";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        urgent ? "border-danger/30 bg-danger/10 text-danger" : "border-border bg-accent/40 text-muted"
      }`}
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

function taskListRowId(row: TaskListRow): string {
  return row.kind === "task" ? row.task.id : row.id;
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
  const assignmentDirectory = useWorkAssignmentDirectory({ managerUserId: userId });
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [assignedServices, setAssignedServices] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [reminderPreview, setReminderPreview] = useState<ManagerTask | null>(null);
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilterId, setPropertyFilterId] = useState("");
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [listFilter, setListFilter] = useState<ManagerTaskListFilterId>("all");

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
      setAssignedServices(serviceRequestsAssignedToViewer(userId));
    };
    window.addEventListener(MANAGER_TASKS_EVENT, onChange);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onChange);
    return () => {
      window.removeEventListener(MANAGER_TASKS_EVENT, onChange);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onChange);
    };
  }, [userId]);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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
      .sort((a, b) => rowSortKey(b).localeCompare(rowSortKey(a)));
  }, [
    assignedServices,
    doneTasks,
    inProgressTasks,
    listFilter,
    matchesProperty,
    overdueTasks,
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
    portalFilterActiveCount([listFilter !== "all" ? listFilter : "", propertyFilterId]);

  const taskFilterFieldCount = (propertyOptions.length > 1 ? 1 : 0) + 2;

  const tasksFilterSheet = (
    <PortalFilterSortSheet
      activeCount={taskFilterActiveCount}
      compactPanel
      filterFieldCount={taskFilterFieldCount}
      constrainDropdownToTitleBand
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => {
        setListFilter("all");
        setPropertyFilterId("");
        setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
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
      />
    </PortalFilterSortSheet>
  );

  useEffect(() => {
    setSelectedIds([]);
  }, [tabId, propertyFilterId, listFilter, groupMode]);

  useEffect(() => {
    if (tabId !== "in-progress" && listFilter === "service_orders") {
      setListFilter("all");
    }
  }, [listFilter, tabId]);

  const selectedTaskRows = useMemo(
    () =>
      visibleRows.filter(
        (row): row is Extract<TaskListRow, { kind: "task" }> =>
          row.kind === "task" && selectedIds.includes(row.id),
      ),
    [visibleRows, selectedIds],
  );

  const selectedTasks = useMemo(
    () => selectedTaskRows.map((row) => row.task),
    [selectedTaskRows],
  );

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

  const assigneeDirectory = useMemo(
    () => ({
      teamMembers: assignmentDirectory.teamMembers,
      vendors: assignmentDirectory.vendors.map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        email: vendor.email,
      })),
    }),
    [assignmentDirectory.teamMembers, assignmentDirectory.vendors],
  );

  function openReminderPreview(task: ManagerTask) {
    const email = resolveTaskAssigneeEmail(task.assignee, assigneeDirectory);
    if (!email) {
      showToast("Add an email for the assignee before sending a reminder.");
      return;
    }
    setReminderPreview(task);
  }

  async function sendTaskReminder(
    task: ManagerTask,
    draft?: { subject?: string; body?: string },
  ): Promise<boolean> {
    setSendingReminderId(task.id);
    try {
      const preview = buildManagerTaskReminderPreview({ task });
      const res = await fetch("/api/portal/send-task-reminder", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          subject: draft?.subject?.trim() || preview.subject,
          text: draft?.body?.trim() || preview.body,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        showToast(data.error ?? "Could not send reminder.");
        return false;
      }
      showToast("Reminder sent by email.");
      await refresh();
      return true;
    } catch {
      showToast("Could not send reminder.");
      return false;
    } finally {
      setSendingReminderId(null);
    }
  }

  async function bulkComplete(rows: ManagerTask[]) {
    if (!userId || rows.length === 0) return;
    const target = !rows[0]!.completed;
    let done = 0;
    for (const task of rows) {
      try {
        await updateManagerTask(userId, task.id, { completed: target });
        done += 1;
      } catch {
        // Keep going; the count below is what the manager is told.
      }
    }
    reapplyManagerTasksToCalendar(userId);
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

  async function bulkDelete(rows: ManagerTask[]) {
    if (!userId || rows.length === 0) return;
    let done = 0;
    for (const task of rows) {
      try {
        await deleteManagerTask(userId, task.id);
        done += 1;
      } catch {
        // Same reasoning as bulkComplete: report what landed.
      }
    }
    reapplyManagerTasksToCalendar(userId);
    setSelectedIds([]);
    await refresh();
    showToast(done === rows.length ? `Removed ${done}.` : `Removed ${done} of ${rows.length}.`);
  }

  function beginEdit(task: ManagerTask) {
    setEditingId(task.id);
    setAddOpen(true);
  }

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleClusterSelection = useCallback((ids: readonly string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !ids.includes(id));
      return [...new Set([...prev, ...ids])];
    });
  }, []);

  const renderClusterHeaderCheckbox = (rows: TaskListClusterRow[], label: string) => (
    <PortalListClusterSelectCheckbox
      ids={rows.map((row) => taskListRowId(row))}
      selectedIds={selectedIdSet}
      onToggleCluster={toggleClusterSelection}
      ariaLabel={`Select all ${label}`}
    />
  );

  const bulkSelectionActions = useMemo(() => {
    if (selectedTasks.length === 0) return null;

    const completeLabel = tabId === "completed" ? "Mark open" : "Mark completed";
    const completeTasks = () => void bulkComplete(selectedTasks);
    const deleteTasks = () => void bulkDelete(selectedTasks);

    const actions: PortalAdaptiveAction[] = [
      {
        id: "complete",
        keepPriority: 5,
        node: (
          <Button
            type="button"
            variant="outline"
            className={TASK_BULK_BAR_BTN}
            data-attr="manager-task-mark-completed"
            onClick={completeTasks}
          >
            {completeLabel}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="manager-task-mark-completed" onSelect={completeTasks}>
            {completeLabel}
          </DropdownMenuItem>
        ),
      },
    ];

    if (selectedTasks.length === 1) {
      const task = selectedTasks[0]!;
      const editTask = () => beginEdit(task);
      const remindTask = () => openReminderPreview(task);
      const canRemind = Boolean(resolveTaskAssigneeEmail(task.assignee, assigneeDirectory));
      actions.push({
        id: "edit",
        keepPriority: 4,
        node: (
          <Button
            type="button"
            variant="outline"
            className={TASK_BULK_BAR_BTN}
            data-attr="manager-task-edit-selected"
            onClick={editTask}
          >
            Edit
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="manager-task-edit-selected" onSelect={editTask}>
            Edit
          </DropdownMenuItem>
        ),
      });
      if (canRemind && tabId !== "completed") {
        actions.push({
          id: "remind",
          keepPriority: 3,
          node: (
            <Button
              type="button"
              variant="outline"
              className={TASK_BULK_BAR_BTN}
              data-attr="manager-task-remind-selected"
              onClick={remindTask}
            >
              Remind
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem data-attr="manager-task-remind-selected" onSelect={remindTask}>
              Remind
            </DropdownMenuItem>
          ),
        });
      }
    }

    actions.push({
      id: "delete",
      keepPriority: 0,
      node: (
        <Button
          type="button"
          variant="outline"
          className={cn(TASK_BULK_BAR_BTN, "text-danger")}
          data-attr="manager-task-delete-selected"
          onClick={deleteTasks}
        >
          Delete
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem data-attr="manager-task-delete-selected" onSelect={deleteTasks}>
          Delete
        </DropdownMenuItem>
      ),
    });

    return (
      <PortalAdaptiveActionRow
        actions={actions}
        moreAriaLabel="More task actions"
        moreDataAttr="manager-task-bulk-more-actions"
        gapPx={4}
      />
    );
  }, [assigneeDirectory, selectedTasks, tabId]);

  function renderTaskRow(task: ManagerTask, completed = false) {
    const location = compactTaskLocationLabel(task);
    const assigneeLabel = formatTaskAssignee(task);
    const canRemind = Boolean(resolveTaskAssigneeEmail(task.assignee, assigneeDirectory));
    return (
      <li key={task.id} className="flex items-start gap-3 px-4 py-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={selectedIds.includes(task.id)}
          aria-label={`Select ${task.title}`}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            setSelectedIds((prev) =>
              event.target.checked ? [...prev, task.id] : prev.filter((id) => id !== task.id),
            )
          }
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="w-full text-left"
            data-attr="manager-task-row-open"
            onClick={() => beginEdit(task)}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className={`font-semibold ${completed ? "text-muted" : "text-foreground"}`}>
                {task.title}
              </p>
              <ManagerTaskUrgencyBadge task={task} />
              <ManagerTaskPriorityBadge priority={task.priority} />
            </div>
            <p className="text-sm text-muted">{formatTaskSchedule(task)}</p>
            {assigneeLabel ? <p className="text-xs text-muted">{assigneeLabel}</p> : null}
            {location ? <p className="text-xs text-muted">{location}</p> : null}
            {task.notes ? <TaskNotesSnippet notes={task.notes} /> : null}
          </button>
          {!completed && canRemind ? (
            <Button
              type="button"
              variant="outline"
              className="mt-2 h-8 min-h-0 px-3 text-[11px] font-semibold"
              data-attr="manager-task-send-reminder"
              loading={sendingReminderId === task.id}
              onClick={() => openReminderPreview(task)}
            >
              Remind
            </Button>
          ) : null}
        </div>
      </li>
    );
  }

  function renderServiceRow(request: ServiceRequest) {
    const location = serviceRequestLocationLabel(request);
    const bucket = serviceRequestBucket(request);
    const rowId = `service-${request.id}`;
    return (
      <li key={rowId} className="flex items-start gap-3 px-4 py-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-primary"
          checked={selectedIds.includes(rowId)}
          aria-label={`Select ${request.offerName}`}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) =>
            setSelectedIds((prev) =>
              event.target.checked ? [...prev, rowId] : prev.filter((id) => id !== rowId),
            )
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{request.offerName}</p>
            <span className="rounded-full border border-border bg-accent/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Service order
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold capitalize text-muted">
              {request.status}
            </span>
          </div>
          {location ? <p className="mt-0.5 text-xs text-muted">{location}</p> : null}
          {request.notes ? <TaskNotesSnippet notes={request.notes} /> : null}
          <Link
            href={serviceRequestDetailHref(basePath, bucket, request.id)}
            className="mt-2 inline-block text-xs font-semibold text-primary"
            data-attr="manager-task-list-service-link"
          >
            Open service order
          </Link>
        </div>
      </li>
    );
  }

  function renderTaskClusters(
    clusters: ReturnType<typeof clusterPortalListRows<TaskListClusterRow>>,
  ) {
    if (isPropertyClusterList(groupMode, clusters)) {
      return clusters.map((cluster) => (
        <ApplicationHouseholdCluster
          key={cluster.key}
          headerLeading={renderClusterHeaderCheckbox(cluster.rows, cluster.propertyLabel || "items")}
          header={
            <>
              <span className="truncate text-xs font-semibold text-foreground">{cluster.propertyLabel}</span>
              <Badge tone="info">
                {cluster.rows.length === 1 ? "1 item" : `${cluster.rows.length} items`}
              </Badge>
            </>
          }
        >
          <ul className="divide-y divide-border">
            {cluster.rows.map((row) =>
              row.kind === "task"
                ? renderTaskRow(row.task, tabId === "completed")
                : renderServiceRow(row.request),
            )}
          </ul>
        </ApplicationHouseholdCluster>
      ));
    }

    return clusters.map((cluster) => (
      <ApplicationHouseholdCluster
        key={cluster.key}
        headerLeading={renderClusterHeaderCheckbox(cluster.rows, cluster.residentLabel || "items")}
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
            <Badge tone="info">
              {cluster.rows.length === 1 ? "1 item" : `${cluster.rows.length} items`}
            </Badge>
          </>
        }
      >
        <ul className="divide-y divide-border">
          {cluster.rows.map((row) =>
            row.kind === "task"
              ? renderTaskRow(row.task, tabId === "completed")
              : renderServiceRow(row.request),
          )}
        </ul>
      </ApplicationHouseholdCluster>
    ));
  }

  const reminderPreviewContent = reminderPreview
    ? buildManagerTaskReminderPreview({ task: reminderPreview })
    : null;

  return (
    <ManagerPortalPageShell
      title="Tasks"
      hideTitleOnMobileNav
      titleInlineFilter={tasksFilterSheet}
      titleAside={
        tabId === "in-progress" ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
            data-attr="manager-task-list-add"
            onClick={() => {
              setEditingId(null);
              setAddOpen(true);
            }}
          >
            Add
          </Button>
        ) : undefined
      }
      compactFilterRow
    >
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

        {!loading && visibleRows.length > 0 ? (
          <div
            className={`space-y-4 ${tabId === "completed" ? "opacity-80" : ""}`}
            data-attr="manager-task-groups"
          >
            {renderTaskClusters(clusters)}
          </div>
        ) : null}
      </div>

      {selectedTasks.length > 0 ? (
        <BulkActionBar count={selectedTasks.length} hideCount variant="payments">
          {bulkSelectionActions}
        </BulkActionBar>
      ) : null}

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
            setSelectedIds([]);
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

      {reminderPreview && reminderPreviewContent ? (
        <PortalNotificationPreviewModal
          open
          title="Send task reminder"
          onClose={() => setReminderPreview(null)}
          recipient={taskAssigneeRecipientLabel(reminderPreview, assigneeDirectory)}
          subject={reminderPreviewContent.subject}
          body={reminderPreviewContent.body}
          intro="Review the reminder below. It will be emailed to the assignee."
          showSkipMessage={false}
          showChannelPicker={false}
          emailAvailable
          smsAvailable={false}
          editableBody
          editableSubject
          confirmLabel="Send reminder"
          confirmBusy={sendingReminderId === reminderPreview.id}
          confirmBusyLabel="Sending…"
          onConfirm={async (_skipMessage, _channels, draft) => {
            const ok = await sendTaskReminder(reminderPreview, {
              subject: draft?.subject,
              body: draft?.body,
            });
            if (ok) setReminderPreview(null);
          }}
        />
      ) : null}
    </ManagerPortalPageShell>
  );
}
