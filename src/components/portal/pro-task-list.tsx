"use client";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { workspaceContainsProperty } from "@/lib/workspaces/selection";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { Settings } from "lucide-react";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import {
  PortalFilterSortSheet,
  filterApplyLabel,
  portalFilterActiveCount,
} from "@/components/portal/portal-filter-sort-sheet";
import {
  PORTAL_FILTER_DRAFT_PROPERTY_FILTERS,
  usePortalFilterDraftValues,
} from "@/lib/portal-filter-draft";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerTaskFormModal } from "@/components/portal/pro-task-form-modal";
import { ManagerTaskFilterFields } from "@/components/portal/pro-task-filter-fields";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { TaskListCardRow } from "@/components/portal/pro-task-row";
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
  compactTaskLocationLabel,
  openTasksForListTab,
  serviceRequestLocationLabel,
  serviceRequestsAssignedToViewer,
  selectManagerTaskListRows,
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
  managerTaskDetailHref,
  managerTaskListHref,
  parseServiceRecordTab,
  propertyDetailHref,
  serviceRequestDetailHref,
  vendorDetailHref,
  type ManagerTaskListTabId,
} from "@/lib/portal-detail-routes";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  SERVICE_REQUESTS_EVENT,
  syncServiceRequestsFromServer,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { cn } from "@/lib/utils";

type TaskListRow =
  | { kind: "task"; id: string; task: ManagerTask }
  | { kind: "service"; id: string; request: ServiceRequest };

/**
 * "Show 12 tasks" — what pressing Apply will actually leave on screen.
 *
 * Rendered INSIDE the filter panel's draft provider, because while the panel is
 * open the page's own filter state is deliberately still the applied one: the
 * list behind the panel must not shuffle while you are choosing. So this reads
 * the PENDING values instead and runs them through
 * {@link selectManagerTaskListRows} — the same function the list itself renders
 * from. Two predicates would eventually disagree, and a count that disagrees
 * with the list is worse than no count at all.
 */
function TaskFilterApplyLabel({
  tabId,
  inProgressTasks,
  overdueTasks,
  doneTasks,
  assignedServices,
  workspaceAllowsProperty,
  applied,
  propertyLabelForId,
}: {
  tabId: ManagerTaskListTabId;
  inProgressTasks: ManagerTask[];
  overdueTasks: ManagerTask[];
  doneTasks: ManagerTask[];
  assignedServices: ServiceRequest[];
  workspaceAllowsProperty: (propertyId?: string) => boolean;
  applied: {
    propertyFilters: string[];
    listFilter: ManagerTaskListFilterId;
    assigneeFilterId: string;
    priorityFilter: string;
    sortId: ManagerTaskListSortId;
  };
  propertyLabelForId: (propertyId?: string) => string;
}) {
  const draft = usePortalFilterDraftValues(applied);
  const pendingPropertyId = draft[PORTAL_FILTER_DRAFT_PROPERTY_FILTERS][0] ?? "";
  const count = selectManagerTaskListRows({
    tabId,
    inProgressTasks,
    overdueTasks,
    doneTasks,
    assignedServices,
    matchesProperty: (propertyId) =>
      workspaceAllowsProperty(propertyId) && (!pendingPropertyId || propertyId === pendingPropertyId),
    listFilter: draft.listFilter,
    assigneeFilterId: draft.assigneeFilterId,
    priorityFilter: draft.priorityFilter,
    sortId: draft.sortId,
    propertyLabelForId,
  }).length;
  return <>{filterApplyLabel(count, "task")}</>;
}

const tasksSettingsEntry = getSettingsEntryPoint("tasks");

function serviceRequestBucket(req: ServiceRequest): "pending" | "approved" | "denied" {
  if (req.status === "approved") return "approved";
  if (req.status === "denied") return "denied";
  return "pending";
}

export function ManagerTaskList({
  tabId: serverTabId,
  basePath = "/portal",
  taskId: taskIdProp,
  taskTab: taskTabProp,
}: {
  tabId: ManagerTaskListTabId;
  basePath?: string;
  taskId?: string;
  taskTab?: string;
}) {
  const tabId = useShallowTabId(serverTabId, MANAGER_TASK_LIST_TABS);
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const { userId, email: managerEmail, ready } = useManagerUserId();
  // `Date.now()` cannot be called during render (react-hooks/purity) — a lazy
  // `useState` initializer is the established pattern elsewhere in this app
  // (portal-calendar-panels.tsx, admin-dashboard.tsx).
  const [nowMs] = useState(() => Date.now());
  const [tasks, setTasks] = useState<ManagerTask[]>([]);
  const [assignedServices, setAssignedServices] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilterId, setPropertyFilterId] = useState("");
  const [assigneeFilterId, setAssigneeFilterId] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<ManagerTaskPriority | "">("");
  const [listFilter, setListFilter] = useState<ManagerTaskListFilterId>("all");
  const [sortId, setSortId] = useState<ManagerTaskListSortId>("due_soonest");
  const [listSearch, setListSearch] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(`${tabId}:${listSearch}`);

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

  const visibleRows = useMemo(
    (): TaskListRow[] =>
      selectManagerTaskListRows({
        tabId,
        inProgressTasks,
        overdueTasks,
        doneTasks,
        assignedServices,
        matchesProperty,
        listFilter,
        assigneeFilterId,
        priorityFilter,
        sortId,
        propertyLabelForId,
        searchQuery: listSearch,
      }),
    [
    assignedServices,
    assigneeFilterId,
    doneTasks,
    inProgressTasks,
    listFilter,
    listSearch,
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
        setSortId("due_soonest");
      }}
      dataAttr="tasks-filter-sheet-open"
      applyLabel={
        <TaskFilterApplyLabel
          tabId={tabId}
          inProgressTasks={inProgressTasks}
          overdueTasks={overdueTasks}
          doneTasks={doneTasks}
          assignedServices={assignedServices}
          workspaceAllowsProperty={workspaceContainsProperty}
          propertyLabelForId={propertyLabelForId}
          applied={{
            [PORTAL_FILTER_DRAFT_PROPERTY_FILTERS]: propertyFilterId ? [propertyFilterId] : [],
            listFilter,
            assigneeFilterId,
            priorityFilter,
            sortId,
          }}
        />
      }
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

  function openTaskRecord(task: ManagerTask) {
    navigate(managerTaskDetailHref(basePath, tabId, task.id));
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
            data-record-action-id="edit"
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
          data-record-action-id="complete"
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

    // Delete sorts last — the shared ⋯ order puts a record's own actions
    // (Edit, Mark done/Reopen) before the trailing destructive one
    // (record-action-order.ts).
    actions.push({
      id: "delete",
      node: (
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
          data-attr="manager-tasks-bulk-delete"
          data-record-action-id="delete"
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

    return actions;
  }, [bulkBusy, bulkSetCompleted, editSelectedTask, selectedTaskIds.length, tabId]);

  /**
   * The flat card list — one row per task or assigned service, already sorted
   * (`selectManagerTaskListRows`, "due soonest" by default). No property or
   * assignee group headers: the place line on each card already says the
   * house, and the ⋯ the list surface draws on a selectable row carries that
   * row's own actions.
   */
  function renderTaskRows(rows: TaskListRow[]) {
    return rows.map((row) => {
      if (row.kind === "task") {
        const task = row.task;
        return (
          <TaskListCardRow
            key={task.id}
            task={task}
            propertyLabel={task.propertyTitle ?? propertyLabelForId(task.propertyId)}
            viewerUserId={userId}
            showDoneDate={tabId === "completed"}
            formatRange={formatRangeLabel}
            checked={selectedIds.has(task.id)}
            onSelectedChange={() => toggleSelected(task.id)}
            onOpen={() => openTaskRecord(task)}
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
          className="portal-property-row mb-2 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 shadow-sm max-md:px-2.5 max-md:py-2.5"
          data-attr="manager-task-service-row"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-foreground">{request.offerName}</span>
            <span className="block truncate text-[13px] text-muted">
              {[location, request.status].filter(Boolean).join(" · ")}
            </span>
          </span>
          <Link
            href={serviceRequestDetailHref(basePath, bucket, request.id)}
            className="text-xs font-semibold text-primary"
            data-attr="manager-task-list-service-link"
          >
            Open
          </Link>
        </div>
      );
    });
  }

  function openAddTask() {
    setEditingId(null);
    setAddOpen(true);
  }

  const routeTask = taskIdProp ? tasks.find((row) => row.id === decodeURIComponent(taskIdProp)) : undefined;
  if (taskIdProp && !loading && !routeTask) {
    return <PortalListEmptyCard section="tasks" title="Task not found." dataAttr="manager-task-missing" />;
  }
  if (routeTask) {
    const recordTab = parseServiceRecordTab(taskTabProp);
    const sections = recordSections("manager", "task", { basePath, taskListTab: tabId });
    const onTaskHeaderAction = (actionId: string) => {
      if (actionId === "mark-done") {
        if (!userId) return;
        void updateManagerTask(userId, routeTask.id, { completed: !routeTask.completed }).then(() => {
          setTasks((prev) =>
            prev.map((row) => (row.id === routeTask.id ? { ...row, completed: !routeTask.completed } : row)),
          );
          showToast(routeTask.completed ? "Task reopened." : "Task completed.");
        });
        return;
      }
      if (actionId === "delete") {
        if (!userId) return;
        void deleteManagerTask(userId, routeTask.id).then(() => {
          setTasks((prev) => prev.filter((row) => row.id !== routeTask.id));
          showToast("Task deleted.");
          navigate(managerTaskListHref(basePath, tabId));
        });
        return;
      }
      showToast("Coming soon");
    };
    return (
      <>
        <PortalRecordDetailPage
          pageTitle="Tasks"
          title={routeTask.title}
          subtitle={routeTask.propertyTitle || compactTaskLocationLabel(routeTask) || undefined}
          avatarName={routeTask.title}
          backHref={managerTaskListHref(basePath, tabId)}
          hideBackText
          bareHeader
          dataAttrBack="task-detail-back"
          iconTitleActions
          pinScrollBody
        >
          <PortalRecordActions>
            <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onTaskHeaderAction} />
          </PortalRecordActions>
          <PortalRecordSectionChrome
            sections={sections}
            recordId={routeTask.id}
            activeId={recordTab}
            title={routeTask.title}
            backHref={managerTaskListHref(basePath, tabId)}
            backLabel="All tasks"
            ariaLabel="Task sections"
            onHeaderAction={onTaskHeaderAction}
          >
            {(() => {
              const dueLabel = routeTask.start && routeTask.end
                ? formatRangeLabel(routeTask.start, routeTask.end)
                : routeTask.dueDate
                  ? new Date(routeTask.dueDate).toLocaleDateString()
                  : "—";
              const dueSoon = !routeTask.completed && Boolean(routeTask.dueDate) && new Date(routeTask.dueDate!).getTime() - nowMs <= 3 * 24 * 60 * 60 * 1000;
              const vendorAssignee = routeTask.assignee?.type === "vendor" ? routeTask.assignee : undefined;
              return recordTab === "communication" ? (
                renderRecordSection("communication", {
                  role: "manager",
                  kind: "task",
                  kindLabel: "task",
                  recordId: routeTask.id,
                  recordLabel: routeTask.title,
                })
              ) : (
                renderRecordSection("overview", {
                  role: "manager",
                  kind: "task",
                  kindLabel: "task",
                  recordId: routeTask.id,
                  recordLabel: routeTask.title,
                  overviewTiles: [
                    { id: "status", label: "Status", value: routeTask.completed ? "Done" : "Open" },
                    { id: "due", label: "Due", value: dueLabel, tone: dueSoon ? "danger" : "default" },
                    { id: "assignee", label: "Assignee", value: routeTask.assignee?.name || "Unassigned" },
                    { id: "priority", label: "Priority", value: routeTask.priority ? MANAGER_TASK_PRIORITY_LABELS[routeTask.priority] : "—" },
                  ],
                  overviewNeeds: dueSoon
                    ? [{ id: "due", title: "Due soon", detail: dueLabel }]
                    : [],
                  overviewCards: [
                    {
                      id: "task",
                      title: "Task",
                      action: { label: "Property", href: routeTask.propertyId ? propertyDetailHref(basePath, "all", routeTask.propertyId, "preview") : `${basePath}/properties/all` },
                      rows: [
                        { label: "Property", value: routeTask.propertyTitle || "—" },
                        { label: "Assignee", value: routeTask.assignee?.name || "Unassigned" },
                        ...(routeTask.notes ? [{ label: "Details", value: routeTask.notes }] : []),
                      ],
                    },
                    {
                      id: "payments",
                      title: "Payments",
                      kind: "rows",
                      rows: [],
                      emptyLabel: "No charges yet",
                    },
                    {
                      id: "vendor",
                      title: "Vendor",
                      rows: [
                        { label: "Assigned", value: vendorAssignee ? vendorAssignee.name : "Unassigned" },
                      ],
                      action: vendorAssignee ? { label: "Vendor record", href: vendorDetailHref(basePath, vendorAssignee.id) } : undefined,
                    },
                  ],
                })
              );
            })()}
          </PortalRecordSectionChrome>
        </PortalRecordDetailPage>
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
            onSaved={async () => {
              await refresh();
              showToast("Task updated.");
            }}
          />
        ) : null}
      </>
    );
  }

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
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search tasks",
          dataAttr: "manager-tasks-search",
        }}
        activeFilterChips={activeFilterChips.length > 0 ? <PortalActiveFilterChips chips={activeFilterChips} /> : undefined}
        actions={
          <>
            {tasksFilterSheet}
            <PortalIconAction
              icon={Settings}
              label={tasksSettingsEntry.label}
              data-attr={tasksSettingsEntry.dataAttr}
              onClick={() => setSettingsOpen(true)}
            />
          </>
        }
        primary={<PortalPrimaryIconAction label="Add task" data-attr="manager-task-add-top" onClick={openAddTask} />}
      />

      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedTaskIds.length} bulkActions={selectedTaskIds.length > 0 ? (
        <>
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </>
      ) : null}><div className={PORTAL_LIST_PAGE_BODY}>
        {loading ? <p className="text-sm text-muted">Loading…</p> : null}

        {!loading && visibleRows.length > 0 ? (
          <div
            className={cn(tabId === "completed" && "opacity-80")}
            data-attr="manager-task-groups"
          >
            {renderTaskRows(visibleRows)}
          </div>
        ) : null}

        {!loading && visibleRows.length === 0 ? (
          <PortalListEmptyCard
            section="tasks"
            tone={listSearch.trim() || activeFilterChips.length > 0 ? "muted" : "default"}
            title={
              listSearch.trim()
                ? portalEmptyNoMatchTitle("tasks", listSearch)
                : activeFilterChips.length > 0
                  ? portalEmptyNoMatchTitle("tasks")
                  : portalEmptyCopy(`tasks.${tabId === "in-progress" ? "open" : tabId}` as PortalEmptyCopyKey).title
            }
            clear={
              listSearch.trim()
                ? {
                    label: "Clear search",
                    onClick: () => setListSearch(""),
                    dataAttr: "manager-task-empty-clear-search",
                  }
                : activeFilterChips.length > 0
                ? {
                    label: "Clear filters",
                    onClick: () => {
                      setListFilter("all");
                      setPropertyFilterId("");
                      setAssigneeFilterId("");
                      setPriorityFilter("");
                    },
                    dataAttr: "manager-task-empty-clear-filters",
                  }
                : null
            }
            sibling={listSearch.trim() || activeFilterChips.length > 0 ? null : portalEmptySibling(tabItems, tabId)}
            // Overdue and Done are states a task falls into; a new one starts open.
            actions={tabId === "in-progress" ? [{ label: "Add task", onClick: openAddTask, dataAttr: "manager-task-list-add" }] : []}
            dataAttr="manager-task-empty"
          />
        ) : null}
      </div></PortalRecordListSurface>

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
        scopedTitle={settingsDialogTitlePrefix(tasksSettingsEntry)}
        propertyOptions={propertyOptions}
      />
    </ManagerPortalPageShell>
  );
}
