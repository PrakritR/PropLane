"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DestinationNav } from "@/components/ui/destination-nav";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerTaskFilterFields } from "@/components/portal/manager-task-filter-fields";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { ManagerTaskFormModal } from "@/components/portal/manager-task-form-modal";
import { ManagerCommunicationComposeModal } from "@/components/portal/manager-communication-compose-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { formatRangeLabel, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  compactTaskLocationLabel,
  serviceRequestLocationLabel,
  serviceRequestsAssignedToViewer,
  taskListRowMatchesFilter,
  taskNotesPreview,
  type ManagerTaskListFilterId,
} from "@/lib/manager-task-display";
import {
  MANAGER_TASKS_EVENT,
  deleteManagerTask,
  fetchManagerTasks,
  reapplyManagerTasksToCalendar,
  updateManagerTask,
  type ManagerTask,
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
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilterId, setPropertyFilterId] = useState("");
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

  const openTasks = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => task.completed), [tasks]);

  const matchesProperty = useCallback(
    (propertyId?: string) => !propertyFilterId || propertyId === propertyFilterId,
    [propertyFilterId],
  );

  const visibleRows = useMemo((): TaskListRow[] => {
    const taskRows: TaskListRow[] = (tabId === "completed" ? doneTasks : openTasks)
      .filter((task) => matchesProperty(task.propertyId))
      .map((task) => ({ kind: "task", id: task.id, task }));
    const serviceRows: TaskListRow[] =
      tabId === "completed"
        ? []
        : assignedServices
            .filter((req) => matchesProperty(req.propertyId))
            .map((request) => ({ kind: "service", id: `service-${request.id}`, request }));
    return [...taskRows, ...serviceRows]
      .filter((row) => taskListRowMatchesFilter(row, listFilter))
      .sort((a, b) => rowSortKey(b).localeCompare(rowSortKey(a)));
  }, [assignedServices, doneTasks, listFilter, matchesProperty, openTasks, tabId]);

  const taskFilterActiveCount = portalFilterActiveCount([
    listFilter !== "all" ? listFilter : "",
    propertyFilterId,
  ]);

  const taskFilterFieldCount = propertyOptions.length > 1 ? 2 : 1;

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
      />
    </PortalFilterSortSheet>
  );

  useEffect(() => {
    setSelectedIds([]);
  }, [tabId, propertyFilterId, listFilter]);

  useEffect(() => {
    if (tabId === "completed" && listFilter === "services") {
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

  const tabItems = useMemo(
    () =>
      MANAGER_TASK_LIST_TABS.map((id) => ({
        id,
        label: MANAGER_TASK_LIST_TAB_LABELS[id],
        href: managerTaskListHref(basePath, id),
        count:
          id === "completed"
            ? doneTasks.length
            : openTasks.length + assignedServices.filter((req) => matchesProperty(req.propertyId)).length,
        dataAttr: `manager-task-list-tab-${id}`,
      })),
    [assignedServices, basePath, doneTasks.length, matchesProperty, openTasks.length],
  );

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
  }, [selectedTasks, tabId]);

  function renderTaskRow(task: ManagerTask, completed = false) {
    const location = compactTaskLocationLabel(task);
    const assigneeLabel = formatTaskAssignee(task);
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
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          data-attr="manager-task-row-open"
          onClick={() => beginEdit(task)}
        >
          <p className={`font-semibold text-foreground ${completed ? "line-through" : ""}`}>{task.title}</p>
          <p className="text-sm text-muted">{formatTaskSchedule(task)}</p>
          {assigneeLabel ? <p className="text-xs text-muted">{assigneeLabel}</p> : null}
          {location ? <p className="text-xs text-muted">{location}</p> : null}
          {task.notes ? <TaskNotesSnippet notes={task.notes} /> : null}
        </button>
      </li>
    );
  }

  function renderServiceRow(request: ServiceRequest) {
    const location = serviceRequestLocationLabel(request);
    const bucket = serviceRequestBucket(request);
    return (
      <li key={`service-${request.id}`} className="flex items-start gap-3 px-4 py-3">
        <span className="mt-1 inline-block h-4 w-4 shrink-0" aria-hidden />
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

  return (
    <ManagerPortalPageShell
      title="Tasks"
      hideTitleOnMobileNav
      titleInlineFilter={tasksFilterSheet}
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
          <ul
            className={`divide-y divide-border rounded-2xl border border-border bg-card ${tabId === "completed" ? "opacity-80" : ""}`}
          >
            {visibleRows.map((row) =>
              row.kind === "task"
                ? renderTaskRow(row.task, tabId === "completed")
                : renderServiceRow(row.request),
            )}
          </ul>
        ) : null}

        {tabId === "in-progress" ? (
          <PortalListAddRow
            label="Add task"
            icon={PORTAL_LIST_ADD_ICONS.request}
            onClick={() => {
              setEditingId(null);
              setAddOpen(true);
            }}
            dataAttr="manager-task-list-add"
          />
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
    </ManagerPortalPageShell>
  );
}
