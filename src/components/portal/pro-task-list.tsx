"use client";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ListSkeleton } from "@/components/ui/list-skeleton";

import { workspaceContainsProperty } from "@/lib/workspaces/selection";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { firstNonEmptyTabToOpen } from "@/lib/portal-default-tab";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
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
import { ManagerServiceCardRow } from "@/components/portal/pro-service-card-row";
import { managerServiceRequestCardFigure } from "@/lib/manager-service-list-row";
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
  compactTaskPropertyLabel,
  isManagerTaskLate,
  managerTaskRowInScope,
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
import { managerTaskStage, serviceRequestTaskStage } from "@/lib/manager-task-stage";
import { TaskAssignDialog } from "@/components/portal/task-assign-dialog";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { readAllPlannedEvents } from "@/lib/demo-admin-scheduling";
import type { WorkAssignee } from "@/lib/work-assignment";
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
import { resolveTaskCommunicationParty } from "@/lib/task-communication-party";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { MANAGER_WORK_ORDERS_EVENT, readManagerWorkOrderRows, syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";
import { MANAGER_VENDORS_EVENT, syncManagerVendorsFromServer } from "@/lib/manager-vendors-storage";
import { readLeasePipeline, syncLeasePipelineFromServer } from "@/lib/lease-pipeline-storage";
import { activeWorkspaceSummary } from "@/lib/workspaces/selection";
import { useSelectedWorkspaceId } from "@/hooks/use-selected-workspace-id";
import { workspaceTeamThreadId } from "@/lib/team-thread-id";
import { teamThreadDisplayName } from "@/lib/team-thread-display";

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
  tasks,
  assignedServices,
  workspaceAllowsProperty,
  applied,
  propertyLabelForId,
}: {
  tabId: ManagerTaskListTabId;
  tasks: ManagerTask[];
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
    tasks,
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
  const [assignOpen, setAssignOpen] = useState(false);
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  // A task page's Communication is with the person the task is about, found from rows this page does not
  // otherwise load (applications, services, vendors, leases). They are read from the same client caches the
  // rest of the portal fills; a tick re-resolves the party when a sync lands. An empty cache is "not read
  // yet", not "nobody": `partySourcesReady` is what tells the pane the answer is final, so a cold load never
  // opens the Team chat and then silently repoints the composer at the task's contact.
  const [partySourceTick, setPartySourceTick] = useState(0);
  const [partySourcesReady, setPartySourcesReady] = useState(false);
  const workspaceId = useSelectedWorkspaceId();
  // Only a countersign task's party comes from the lease pipeline, and nothing else on this page reads it.
  const needsLeaseSource = Boolean(
    taskIdProp &&
      tasks.some((row) => row.id === decodeURIComponent(taskIdProp) && row.templateKey === "countersign_lease"),
  );
  useEffect(() => {
    if (!taskIdProp || !userId) {
      setPartySourcesReady(false);
      return;
    }
    let active = true;
    setPartySourcesReady(false);
    const bump = () => setPartySourceTick((n) => n + 1);
    void Promise.allSettled([
      syncManagerApplicationsFromServer({ managerUserId: userId }),
      syncManagerWorkOrdersFromServer(),
      syncManagerVendorsFromServer(),
      ...(needsLeaseSource ? [syncLeasePipelineFromServer(userId)] : []),
    ]).then(() => {
      if (!active) return;
      bump();
      setPartySourcesReady(true);
    });
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    window.addEventListener(MANAGER_VENDORS_EVENT, bump);
    return () => {
      active = false;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(MANAGER_VENDORS_EVENT, bump);
    };
  }, [taskIdProp, userId, needsLeaseSource]);

  const matchesProperty = useCallback(
    (propertyId?: string) =>
      managerTaskRowInScope(propertyId, { workspaceContains: workspaceContainsProperty, propertyFilterId }),
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
        tasks,
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
    tasks,
    listFilter,
    listSearch,
    matchesProperty,
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
          tasks={tasks}
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

  const tabItems = useMemo(() => {
    const counts: Record<string, number> = { open: 0, assigned: 0, scheduled: 0, completed: 0 };
    for (const task of tasks) {
      if (matchesProperty(task.propertyId)) counts[managerTaskStage(task)] += 1;
    }
    for (const req of assignedServices) {
      if (matchesProperty(req.propertyId)) counts[serviceRequestTaskStage(req)] += 1;
    }
    return MANAGER_TASK_LIST_TABS.map((id) => ({
      id,
      label: MANAGER_TASK_LIST_TAB_LABELS[id],
      href: managerTaskListHref(basePath, id),
      count: counts[id],
      dataAttr: `manager-task-list-tab-${id}`,
    }));
  }, [assignedServices, basePath, matchesProperty, tasks]);

  // `/tasks` names no tab. Open on the first tab that has rows (once, on arrival) instead of an
  // empty Open; an explicit URL tab, or any later navigation, is left alone.
  const pathname = usePathname();
  const arrivalPathRef = useRef<string | null>(null);
  const defaultTabSettledRef = useRef(false);
  useEffect(() => {
    if (defaultTabSettledRef.current || loading || taskIdProp) return;
    if (arrivalPathRef.current === null) arrivalPathRef.current = pathname ?? "";
    if (pathname !== arrivalPathRef.current) {
      defaultTabSettledRef.current = true;
      return;
    }
    const last = pathname?.split("/").filter(Boolean).pop() ?? "";
    const urlNamesTab = (MANAGER_TASK_LIST_TABS as readonly string[]).includes(last);
    const next = firstNonEmptyTabToOpen(tabItems, tabId, urlNamesTab);
    defaultTabSettledRef.current = true;
    if (!next) return;
    const href = tabItems.find((tab) => tab.id === next)?.href;
    if (!href) return;
    window.history.replaceState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [loading, pathname, tabId, tabItems, taskIdProp]);

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
        const savedById = new Map<string, Awaited<ReturnType<typeof updateManagerTask>>>();
        for (const taskId of selectedTaskIds) {
          savedById.set(taskId, await updateManagerTask(userId, taskId, { completed }));
        }
        setTasks((prev) => prev.map((row) => savedById.get(row.id) ?? row));
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

    const completeLabel = tabId === "completed" ? "Reopen" : "Complete";
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
      // An assigned service rides the same Payments-shaped card as a task:
      // the requester's name, "service · house", and when it was requested.
      return (
        <ManagerServiceCardRow
          key={`service-${request.id}`}
          row={{
            title: request.offerName,
            residentName: request.residentName,
            residentEmail: request.residentEmail,
            propertyLabel: compactTaskPropertyLabel(request.propertyId) ?? "",
            unitLabel: "",
            scheduledIso: "",
            createdIso: request.requestedAt,
          }}
          figure={managerServiceRequestCardFigure(request)}
          onOpen={() => navigate(serviceRequestDetailHref(basePath, bucket, request.id))}
          dataAttr="manager-task-service-row"
        />
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
    // The Linked section is retired: an old `…/linked` link opens the Task section.
    const parsedTab = parseServiceRecordTab(taskTabProp);
    const recordTab = parsedTab === "linked" ? "overview" : parsedTab;
    const workspace = activeWorkspaceSummary();
    // Offered only once the party sources have answered: before that an empty cache reads as "no party", and
    // the pane would force the Team view on a task that does have a contact.
    const teamChat =
      partySourcesReady && workspace && workspace.id === workspaceId
        ? { threadId: workspaceTeamThreadId(workspace.ownerUserId, workspace.id), label: teamThreadDisplayName(workspace.name) }
        : undefined;
    void partySourceTick;
    const party = resolveTaskCommunicationParty(routeTask, {
      applications: readManagerApplicationRows(),
      // The full history, not the week grid's: a task about a tour that already happened (or was cancelled)
      // still names its prospect, and that is who its Communication is with.
      tours: readAllPlannedEvents(),
      workOrders: readManagerWorkOrderRows(),
      vendors,
      leases: routeTask.templateKey === "countersign_lease" ? readLeasePipeline(userId) : undefined,
    });
    const sections = recordSections("manager", "task", { basePath, taskListTab: tabId }, recordTab);
    const headerActions = sections.headerActions.map((action) =>
      action.id === "complete" && routeTask.completed ? { ...action, label: "Reopen" } : action,
    );
    const setCompleted = async (completed: boolean) => {
      if (!userId) return;
      try {
        const saved = await updateManagerTask(userId, routeTask.id, { completed });
        setTasks((prev) => prev.map((row) => (row.id === routeTask.id ? saved : row)));
        showToast(completed ? "Task completed." : "Task reopened.");
      } catch (e) {
        // Without this the write's rejection was unhandled and the row kept its old state, so
        // the manager believed a task was completed when the request had 4xx'd or gone offline.
        showToast(e instanceof Error ? e.message : "Could not save the task.");
      }
    };
    const assignTask = async (assignee: WorkAssignee | null) => {
      if (!userId) return;
      try {
        await updateManagerTask(userId, routeTask.id, { assignee });
        setTasks((prev) => prev.map((row) => (row.id === routeTask.id ? { ...row, assignee: assignee ?? undefined } : row)));
        showToast(assignee ? `Assigned to ${assignee.name?.trim() || "teammate"}.` : "Task unassigned.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not assign the task.");
      }
    };
    const onTaskHeaderAction = (actionId: string) => {
      if (actionId === "complete") {
        void setCompleted(!routeTask.completed);
        return;
      }
      if (actionId === "edit" || actionId === "schedule") {
        beginEdit(routeTask);
        return;
      }
      if (actionId === "assign") {
        setAssignOpen(true);
        return;
      }
      if (actionId === "delete") {
        if (!userId) return;
        void (async () => {
          try {
            await deleteManagerTask(userId, routeTask.id);
            setTasks((prev) => prev.filter((row) => row.id !== routeTask.id));
            showToast("Task deleted.");
            navigate(managerTaskListHref(basePath, tabId));
          } catch (e) {
            showToast(e instanceof Error ? e.message : "Could not delete the task.");
          }
        })();
      }
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
            <PortalRecordHeaderIconActions actions={headerActions} onAction={onTaskHeaderAction} primaryId="complete" keepInlineOnDesktop />
          </PortalRecordActions>
          <PortalRecordSectionChrome
            sections={{ ...sections, headerActions }}
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
              const overdue = !routeTask.completed && isManagerTaskLate(routeTask, nowMs);
              const dueSoon = !overdue && !routeTask.completed && Boolean(routeTask.dueDate) && new Date(routeTask.dueDate!).getTime() - nowMs <= 3 * 24 * 60 * 60 * 1000;
              const vendorAssignee = routeTask.assignee?.type === "vendor" ? routeTask.assignee : undefined;
              if (recordTab === "communication") {
                return renderRecordSection("communication", {
                  role: "manager",
                  kind: "task",
                  kindLabel: "task",
                  recordId: routeTask.id,
                  recordLabel: routeTask.title,
                  contactIds: party?.emails,
                  contactName: party?.name,
                  contactPhone: party?.phone ?? undefined,
                  teamChat,
                });
              }
              return renderRecordSection("overview", {
                role: "manager",
                kind: "task",
                kindLabel: "task",
                recordId: routeTask.id,
                recordLabel: routeTask.title,
                overviewTiles: [
                  { id: "status", label: "Status", value: MANAGER_TASK_LIST_TAB_LABELS[managerTaskStage(routeTask)] },
                  { id: "due", label: "Due", value: overdue ? `Overdue · ${dueLabel}` : dueLabel, tone: overdue || dueSoon ? "danger" : "default" },
                  { id: "assignee", label: "Assignee", value: routeTask.assignee?.name || "No one yet" },
                  { id: "priority", label: "Priority", value: routeTask.priority ? MANAGER_TASK_PRIORITY_LABELS[routeTask.priority] : "—" },
                ],
                overviewNeeds: overdue
                  ? [{ id: "due", title: "Overdue", detail: dueLabel }]
                  : dueSoon
                    ? [{ id: "due", title: "Due soon", detail: dueLabel }]
                    : [],
                overviewCards: [
                  {
                    id: "task",
                    title: "Task",
                    action: { label: "Property", href: routeTask.propertyId ? propertyDetailHref(basePath, "all", routeTask.propertyId, "preview") : `${basePath}/properties/all` },
                    rows: [
                      { label: "Property", value: routeTask.propertyTitle || "—" },
                      { label: "Assigned to", value: routeTask.assignee?.name || "No one yet" },
                      ...(routeTask.notes ? [{ label: "Details", value: routeTask.notes }] : []),
                    ],
                  },
                  // Only a task that has a vendor shows a vendor card; an
                  // empty "Unassigned" card is unrelated chrome.
                  ...(vendorAssignee
                    ? [
                        {
                          id: "vendor",
                          title: "Vendor",
                          rows: [{ label: "Assigned", value: vendorAssignee.name }],
                          action: { label: "Vendor record", href: vendorDetailHref(basePath, vendorAssignee.id) },
                        },
                      ]
                    : []),
                ],
              });
            })()}
          </PortalRecordSectionChrome>
        </PortalRecordDetailPage>
        <TaskAssignDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          current={routeTask.assignee ?? null}
          teamMembers={teamMembers}
          vendors={vendors}
          onAssign={assignTask}
        />
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
        actions={tasksFilterSheet}
        primary={<PortalPrimaryIconAction label="Add task" data-attr="manager-task-add-top" onClick={openAddTask} />}
      />

      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedTaskIds.length} bulkActions={selectedTaskIds.length > 0 ? (
        <>
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </>
      ) : null}><div className={PORTAL_LIST_PAGE_BODY}>
        {loading ? <ListSkeleton rows={4} showLeading={false} /> : null}

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
                  : portalEmptyCopy(`tasks.${tabId}` as PortalEmptyCopyKey).title
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
            // The round + in the command bar is the only create action; no pill or sibling link here.
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
    </ManagerPortalPageShell>
  );
}
