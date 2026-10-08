"use client";

/**
 * The manager sidebar's remaining tabs for the home demo (captain 2026-10-07: every sidebar item opens a panel
 * that mirrors its real page): Tasks, Bookings, Promotion, Forms, Outgoing payments, Finances and Documents.
 * Each copies the real page's structure, read from the code: the title, the tab labels with counts, the search
 * placeholder, the header icon actions (the real Filter popover with the real fields, the Integrations plug, the
 * Balance & payouts landmark), the round blue primary, and the row anatomy (tile, title, place line, glyph facts,
 * bold figure, the row's own ⋯). The round + opens the real pop-up (Add task, Add booking, New promotion, Add
 * payment, Financial entry, Upload document) and a row opens what the real row opens (a record page or a modal),
 * all drawn by `demo-popups-ops.tsx` and loaded on demand (`demo-popups-lazy-ops.tsx`). Nothing saves or fetches:
 * a primary only closes the pop-up and toasts "(sample)".
 * Sources: `pro-task-list`, `pro-bookings`, `pro-promotion`, `forms-list`, `manager-outgoing-invoices-panel`,
 * `pro-finances-panel`, `pro-documents-panel`.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Landmark,
  ListChecks,
  Lock,
  Megaphone,
  MoreHorizontal,
  PiggyBank,
  Plug,
  Receipt,
  Scale,
  ShieldCheck,
  Stethoscope,
  TrendingUp,
  Unlock,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { DemoFilterSheet, filterApplyLabel, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import {
  FilterChipsField,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { PortalListPropertyField } from "@/components/portal/portal-list-group-filter-fields";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import { DataList } from "@/components/ui/data-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Input } from "@/components/ui/input";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { PORTAL_FILTER_DRAFT_PROPERTY_FILTERS, usePortalFilterDraft, usePortalFilterDraftValues } from "@/lib/portal-filter-draft";
import {
  DemoApplicationDocRecord,
  DemoBookingDayDialog,
  DemoBookingPopup,
  DemoBookingRecord,
  DemoConfirmDialog,
  DemoDocumentPreviewDialog,
  DemoExpensePopup,
  DemoFinancialEntryDialog,
  DemoIncomePopup,
  DemoLeaseInlinePreview,
  DemoOutgoingAddPopup,
  DemoOutgoingDialog,
  DemoOutgoingRecord,
  DemoPromotionNewPopup,
  DemoPromotionViewDialog,
  DemoReportPage,
  DemoTaskFormPopup,
  DemoTaskRecord,
  DemoUploadDocumentPopup,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-ops";
import { DemoEditPendingFormPopup, DemoFormViewerPopup, DemoSendFormPopup } from "@/components/marketing/site/product-mock/demo-popups-lazy";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { ProPlaneMarkIcon } from "@/components/brand/axis-logo";
import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { CHANNEL_GLYPH } from "@/lib/listing-channels/channel-glyphs";
import { listingChannelsByGroup, type ListingChannelGroup } from "@/lib/listing-channels/registry";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import type { MonthlyCashflowPoint } from "@/lib/portal-monthly-profit";
import {
  BOOKING_ROWS,
  DOCUMENT_ROWS,
  FINANCE_BY_PROPERTY,
  MANAGER_FORMS,
  OUTGOING_ROWS,
  PROMOTION_ROWS,
  TASK_ROWS,
  type BookingFixtureRow,
  type DocumentFixtureRow,
  type ManagerFormFixture,
  type OutgoingFixtureRow,
  type PromotionFixtureRow,
  type TaskFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures-more";
import {
  OPS_BOOKING_DETAILS,
  OPS_DOCUMENT_CATEGORIES,
  OPS_DOCUMENT_SCOPES,
  OPS_DOC_HOUSE,
  OPS_HOUSES,
  OPS_OTHER_DOCUMENTS,
  OPS_OUTGOING_DETAILS,
  OPS_PROMOTION_DETAILS,
  OPS_REPORTS,
  OPS_TASK_DETAILS,
  type OpsReport,
} from "@/components/marketing/site/product-mock/fixtures-popups-ops";
import { countBy, FixtureListScreen, type FixtureTab, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { DEMO_PAGE_CLASS, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { PROPERTY_ROWS } from "@/components/marketing/site/product-mock/fixtures";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cents = (label: string) => Number(label.replace(/[$,]/g, ""));
const houseOf = (place: string) => place.split(" · ")[0]!;
const PROPERTY_FILTER_OPTIONS = OPS_HOUSES.map((h) => ({ id: h.id, label: h.label }));

/** A record page's frame: the same window as the list, the record drawn straight on the page canvas. */
function OpsRecordScreen({ path, toastNode, children }: { path: string; toastNode: ReactNode; children: ReactNode }) {
  return (
    <ProductWindow path={path}>
      <div className={DEMO_PAGE_CLASS}>{children}</div>
      {toastNode}
    </ProductWindow>
  );
}

/** The one-field property filter the Promotion, Bookings, Applications and Leases pages carry (`PortalListPropertyField`). */
function PropertyFilterSheet({ value, onChange, dataAttr }: { value: string[]; onChange: (next: string[]) => void; dataAttr: string }) {
  return (
    <DemoFilterSheet
      activeCount={portalFilterActiveCount([value])}
      compactPanel
      commandStripTrigger
      filterFieldCount={1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => onChange([])}
      dataAttr={`${dataAttr}-sheet-open`}
    >
      <FilterFieldsAccordion>
        <PortalListPropertyField propertyOptions={PROPERTY_FILTER_OPTIONS} propertyFilters={value} onPropertyFiltersChange={onChange} propertyAllLabel="All houses" propertyDataAttr={`${dataAttr}-property`} />
      </FilterFieldsAccordion>
    </DemoFilterSheet>
  );
}

/** Balance & payouts: the Landmark icon in the command bar (navigates to Settings in the real page; the demo only toasts). */
function BalancePayoutsAction({ toast }: { toast: (text: string) => void }) {
  return <PortalIconAction icon={Landmark} label="Balance & payouts" data-attr="finances-balance-payouts" onClick={() => toast("Balance & payouts (sample)")} />;
}

/** The Integrations plug: the real page's icon (it navigates to Settings there; the demo only toasts). */
function IntegrationsAction({ toast, dataAttr }: { toast: (text: string) => void; dataAttr: string }) {
  return <PortalIconAction icon={Plug} label="Integrations" data-attr={dataAttr} onClick={() => toast("Integrations (sample)")} />;
}

/* ───────────────────────────── Tasks ───────────────────────────── */

const TASK_TABS = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];

const TASK_SORTS = [
  { value: "due_soonest", label: "Due soonest" },
  { value: "due_latest", label: "Due latest" },
  { value: "newest", label: "Newest first" },
  { value: "house", label: "House A-Z" },
  { value: "assignee", label: "Assignee A-Z" },
];
const TASK_TYPES = [
  { value: "all", label: "All" },
  { value: "service_orders", label: "Service orders" },
  { value: "tours", label: "Tours" },
  { value: "general_tasks", label: "Service tasks" },
  { value: "house_tasks", label: "House tasks" },
];
const TASK_PRIORITY_CHIPS = [
  { value: "", label: "Any priority" },
  { value: "high", label: "High" },
  { value: "medium", label: "Normal" },
  { value: "low", label: "Low" },
];
/** Which Type filter a fixture task belongs to (a vendor job is a service task, a house chore a house task). */
const TASK_FILTER_TYPE: Record<string, string> = {
  "task-smoke": "house_tasks",
  "task-keys": "house_tasks",
  "task-spigots": "house_tasks",
  "task-lock": "general_tasks",
  "task-carpet": "general_tasks",
  "task-gutter": "house_tasks",
};

type TaskFilters = { sort: string; type: string; property: string; assignee: string; priority: string };
const TASK_FILTERS_DEFAULT: TaskFilters = { sort: "due_soonest", type: "all", property: "", assignee: "", priority: "" };

function selectTasks(tab: string, f: TaskFilters, search: string): TaskFixtureRow[] {
  const due = (r: TaskFixtureRow) => OPS_TASK_DETAILS[r.id]?.dueDate || OPS_TASK_DETAILS[r.id]?.scheduleDate || "9999-12-31";
  const created = (r: TaskFixtureRow) => Number((OPS_TASK_DETAILS[r.id]?.created ?? "").split(" ")[1] ?? 0);
  return TASK_ROWS.filter(
    (r) =>
      r.bucket === tab &&
      matchesSearch(search, r.title, r.place, r.assignee) &&
      (f.type === "all" || TASK_FILTER_TYPE[r.id] === f.type) &&
      (!f.property || houseOf(r.place) === OPS_HOUSES.find((h) => h.id === f.property)?.label) &&
      (!f.assignee || r.assignee === f.assignee) &&
      (!f.priority || OPS_TASK_DETAILS[r.id]?.priority === f.priority),
  ).sort((a, b) =>
    f.sort === "due_latest" ? due(b).localeCompare(due(a)) : f.sort === "newest" ? created(b) - created(a) : f.sort === "house" ? a.place.localeCompare(b.place) : f.sort === "assignee" ? a.assignee.localeCompare(b.assignee) : due(a).localeCompare(due(b)),
  );
}

/** The Filter popover's fields on Tasks (`ManagerTaskFilterFields`): Sort by, Type, Property, Assignee, Priority. */
function TaskFilterFields({ filters, onChange }: { filters: TaskFilters; onChange: (patch: Partial<TaskFilters>) => void }) {
  const closeFieldMenu = useFilterAccordionClose();
  const [sort, setSort] = usePortalFilterDraft(filters.sort, (v) => onChange({ sort: v }), "due_soonest", "sortId");
  const [type, setType] = usePortalFilterDraft(filters.type, (v) => onChange({ type: v }), "all", "listFilter");
  const [assignee, setAssignee] = usePortalFilterDraft(filters.assignee, (v) => onChange({ assignee: v }), "", "assigneeFilterId");
  const [priority, setPriority] = usePortalFilterDraft(filters.priority, (v) => onChange({ priority: v }), "", "priorityFilter");
  const assigneeOptions = [{ value: "", label: "Anyone" }, ...[...new Set(TASK_ROWS.map((r) => r.assignee).filter((a) => a !== "No one yet"))].map((a) => ({ value: a, label: a }))];
  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection sectionId="sort" label="Sort by" summary={filterSingleSelectSummary(sort, TASK_SORTS, "Due soonest")} empty={sort === "due_soonest"} menuOptionCount={TASK_SORTS.length} dataAttr="tasks-filter-sort-trigger">
        <FilterSingleSelectList options={TASK_SORTS} value={sort} onChange={setSort} dataAttr="tasks-filter-sort" />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection sectionId="category" label="Type" summary={filterSingleSelectSummary(type, TASK_TYPES, "All")} empty={type === "all"} menuOptionCount={TASK_TYPES.length} dataAttr="tasks-filter-category-trigger">
        <FilterSingleSelectList options={TASK_TYPES} value={type} onChange={setType} onPick={closeFieldMenu} dataAttr="tasks-filter-category" />
      </FilterCollapsibleSection>
      <PortalListPropertyField
        propertyOptions={PROPERTY_FILTER_OPTIONS}
        propertyFilters={filters.property ? [filters.property] : []}
        onPropertyFiltersChange={(next) => onChange({ property: next[0] ?? "" })}
        propertyAllLabel="All houses"
        propertyDataAttr="tasks-filter-property"
      />
      <FilterCollapsibleSection sectionId="assignee" label="Assignee" summary={filterSingleSelectSummary(assignee, assigneeOptions, "Anyone")} empty={assignee === ""} menuOptionCount={assigneeOptions.length} dataAttr="tasks-filter-assignee-trigger">
        <FilterSingleSelectList options={assigneeOptions} value={assignee} onChange={setAssignee} onPick={closeFieldMenu} dataAttr="tasks-filter-assignee" />
      </FilterCollapsibleSection>
      <FilterChipsField label="Priority" value={priority} options={TASK_PRIORITY_CHIPS} onChange={setPriority} dataAttr="tasks-filter-priority" />
    </FilterFieldsAccordion>
  );
}

/** "Show N tasks": counted from the SAME predicate the list renders from, over the pending (draft) filters. */
function TasksApplyLabel({ tab, filters, search }: { tab: string; filters: TaskFilters; search: string }) {
  const draft = usePortalFilterDraftValues({
    [PORTAL_FILTER_DRAFT_PROPERTY_FILTERS]: filters.property ? [filters.property] : [],
    listFilter: filters.type,
    assigneeFilterId: filters.assignee,
    priorityFilter: filters.priority,
    sortId: filters.sort,
  });
  const pending: TaskFilters = {
    sort: draft.sortId,
    type: draft.listFilter,
    property: (draft[PORTAL_FILTER_DRAFT_PROPERTY_FILTERS] as string[])[0] ?? "",
    assignee: draft.assigneeFilterId,
    priority: draft.priorityFilter,
  };
  return <>{filterApplyLabel(selectTasks(tab, pending, search).length, "task")}</>;
}

export function TasksPanel() {
  const [tab, setTab] = useState<TaskFixtureRow["bucket"]>("open");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>(TASK_FILTERS_DEFAULT);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TaskFixtureRow | null>(null);
  const [deleting, setDeleting] = useState<TaskFixtureRow | null>(null);
  const [record, setRecord] = useState<TaskFixtureRow | null>(null);
  const patch = (next: Partial<TaskFilters>) => setFilters((current) => ({ ...current, ...next }));
  const counts = useMemo(
    () => countBy(TASK_ROWS.filter((r) => !filters.property || houseOf(r.place) === OPS_HOUSES.find((h) => h.id === filters.property)?.label), (r) => r.bucket, TASK_TABS.map((t) => t.id)),
    [filters.property],
  );
  const rows = selectTasks(tab, filters, search);
  const filtersActive = portalFilterActiveCount([filters.type !== "all" ? filters.type : "", filters.property, filters.assignee, filters.priority, filters.sort !== "due_soonest" ? filters.sort : ""]);
  const selected = TASK_ROWS.find((r) => r.id === selection.only);

  if (record) {
    return (
      <OpsRecordScreen path={`/portal/tasks/${record.bucket}/${record.id}`} toastNode={toastNode}>
        <DemoTaskRecord row={record} onBack={() => setRecord(null)} toast={show} />
      </OpsRecordScreen>
    );
  }

  return (
    <FixtureListScreen
      path="/portal/tasks"
      title="Tasks"
      tabs={TASK_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as TaskFixtureRow["bucket"]);
        selection.clear();
      }}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search tasks"
      actions={
        <DemoFilterSheet
          activeCount={filtersActive}
          compactPanel
          commandStripTrigger
          filterFieldCount={6}
          constrainDropdownToTitleBand={false}
          mobileFlushBody
          onReset={() => setFilters(TASK_FILTERS_DEFAULT)}
          dataAttr="tasks-filter-sheet-open"
          applyLabel={<TasksApplyLabel tab={tab} filters={filters} search={search} />}
        >
          <TaskFilterFields filters={filters} onChange={patch} />
        </DemoFilterSheet>
      }
      primary={{ label: portalListAddPrimaryLabel("task"), onClick: () => setAdding(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        rows.length === 0 && counts[tab]! > 0 && (search.trim() || filtersActive) ? portalEmptyNoMatchTitle("tasks", search) : portalEmptyCopy(`tasks.${tab}` as "tasks.open").title
      }
      emptySection="tasks"
      menu={
        selected ? (
          <>
            <DropdownMenuItem onSelect={() => setEditing(selected)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => show(`${selected.bucket === "completed" ? "Reopen" : "Complete"} (sample)`)}>{selected.bucket === "completed" ? "Reopen" : "Complete"}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDeleting(selected)} className="text-danger">
              Delete
            </DropdownMenuItem>
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {adding ? (
            <DemoTaskFormPopup
              mode="add"
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                show("Task added (sample)");
              }}
            />
          ) : null}
          {editing ? (
            <DemoTaskFormPopup
              mode="edit"
              task={OPS_TASK_DETAILS[editing.id]}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                show("Task saved (sample)");
              }}
            />
          ) : null}
          {deleting ? (
            <DemoConfirmDialog
              title="Delete task"
              body={`Delete ${deleting.title}? This cannot be undone.`}
              confirmLabel="Delete"
              onClose={() => setDeleting(null)}
              onConfirm={() => {
                setDeleting(null);
                show("Task deleted (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.title}
          tileIcon={ListChecks}
          address={r.place}
          facts={
            <>
              <PortalRowFact icon={UserRound}>{r.assignee}</PortalRowFact>
              <PortalRowFact icon={r.bucket === "completed" ? CheckCircle2 : CalendarDays} tone={r.overdue ? "danger" : undefined}>
                {r.when}
              </PortalRowFact>
            </>
          }
          checked={selection.isChecked(r.id)}
          onSelectedChange={(checked) => selection.set(r.id, checked)}
          selectLabel={r.title}
          omitActionView
          onOpen={() => setRecord(r)}
          dataAttr="task-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Bookings ───────────────────────────── */

const BOOKING_TABS = [
  { id: "calendar", label: "Calendar" },
  { id: "upcoming", label: "Upcoming" },
  { id: "inhouse", label: "In-house" },
  { id: "past", label: "Past" },
];
const STATUS_ICON: Record<BookingFixtureRow["status"], LucideIcon> = {
  Confirmed: CheckCircle2,
  "In-house": Building2,
  "Checked out": Clock,
  Hold: Lock,
};

type CalendarView = "day" | "week" | "month" | "year";
const CALENDAR_VIEWS: { value: CalendarView; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];
const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_COLOR: Record<BookingFixtureRow["status"], string> = {
  Hold: "border border-dashed border-[#d9a441] bg-[#fff8e6] text-[#7a5a14]",
  Confirmed: "bg-[#e3f1e6] text-[#1f6b36]",
  "In-house": "bg-[#e1ebff] text-[#1c4fd6]",
  "Checked out": "bg-[#eceff3] text-[#5b6270]",
};
/** The demo's "today": the Sep 25 the whole sample world is set on. */
const DEMO_TODAY = new Date(2025, 8, 25);
const addDays = (date: Date, by: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + by);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Sep 22 – Sep 28" as dates. */
function stayDates(stay: string): { start: Date; end: Date } | null {
  const parse = (label?: string) => {
    const [month, day] = (label ?? "").split(" ");
    const index = MONTH_ABBR.indexOf(month ?? "");
    return index < 0 || !day ? null : new Date(2025, index, Number(day));
  };
  const [a, b] = stay.split(" – ");
  const start = parse(a);
  const end = parse(b);
  return start && end ? { start, end } : null;
}

/** The columns of the calendar for a view: days for Day / Week / Month, months for Year. */
function calendarColumns(view: CalendarView, anchor: Date): Date[] {
  if (view === "day") return [anchor];
  if (view === "week") {
    const monday = addDays(anchor, -((anchor.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }
  if (view === "month") return Array.from({ length: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate() }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), i + 1));
  return Array.from({ length: 12 }, (_, i) => new Date(anchor.getFullYear(), i, 1));
}

/** A stay's first and last column index, clipped to the visible columns; null when wholly outside them. */
function barSpan(stay: string, columns: Date[], view: CalendarView): { from: number; to: number } | null {
  const dates = stayDates(stay);
  if (!dates) return null;
  const key = (d: Date) => (view === "year" ? d.getFullYear() * 12 + d.getMonth() : Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000));
  const first = key(columns[0]!);
  const last = key(columns[columns.length - 1]!);
  const start = key(dates.start);
  const end = key(dates.end);
  if (end < first || start > last) return null;
  return { from: Math.max(0, start - first), to: Math.min(columns.length - 1, end - first) };
}

const rangeTitle = (view: CalendarView, anchor: Date, columns: Date[]) =>
  view === "year"
    ? String(anchor.getFullYear())
    : view === "month"
      ? anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : view === "day"
        ? anchor.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
        : `${columns[0]!.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${columns[6]!.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

/** One bookable row per room of each sample house, or the whole home when it is let as one. */
const roomsOf = (title: string) => {
  const rooms = OPS_HOUSES.find((h) => h.label === title)?.rooms ?? [];
  return rooms.length ? rooms : ["Whole home"];
};

function BookingsCalendarCard({
  rows,
  onOpen,
  onDay,
  onEdit,
}: {
  rows: BookingFixtureRow[];
  onOpen: (row: BookingFixtureRow) => void;
  onDay: (day: Date) => void;
  onEdit: (row: BookingFixtureRow) => void;
}) {
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState(DEMO_TODAY);
  const columns = useMemo(() => calendarColumns(view, anchor), [view, anchor]);
  const step = (direction: number) =>
    setAnchor((current) =>
      view === "day" ? addDays(current, direction) : view === "week" ? addDays(current, direction * 7) : view === "month" ? new Date(current.getFullYear(), current.getMonth() + direction, 1) : new Date(current.getFullYear() + direction, 0, 1),
    );
  const guests = rows.filter((r) => r.status !== "Hold");
  const inRange = guests.filter((r) => barSpan(r.stay, columns, view));
  const staying = inRange.length;
  const checkIns = guests.filter((r) => {
    const dates = stayDates(r.stay);
    return dates && columns.some((c) => (view === "year" ? c.getMonth() === dates.start.getMonth() && c.getFullYear() === dates.start.getFullYear() : sameDay(c, dates.start)));
  }).length;
  const checkOuts = guests.filter((r) => {
    const dates = stayDates(r.stay);
    return dates && columns.some((c) => (view === "year" ? c.getMonth() === dates.end.getMonth() && c.getFullYear() === dates.end.getFullYear() : sameDay(c, dates.end)));
  }).length;
  const beds = OPS_HOUSES.reduce((sum, h) => sum + Math.max(1, h.rooms.length), 0);
  const peak = Math.min(beds, new Set(inRange.filter((r) => r.status === "In-house").map((r) => r.place)).size);
  const template = `150px repeat(${columns.length}, minmax(0, 1fr))`;
  const isToday = (d: Date) => (view === "year" ? false : sameDay(d, DEMO_TODAY));

  return (
    <div className="space-y-2" data-attr="bookings-calendar">
      <div className="rounded-[10px] border border-border bg-card p-4" data-attr="bookings-portfolio-timeline" data-view={view}>
        <div className="flex flex-wrap items-center gap-2">
          <PortalIconAction icon={ChevronLeft} label={`Previous ${view}`} onClick={() => step(-1)} />
          <PortalIconAction icon={ChevronRight} label={`Next ${view}`} onClick={() => step(1)} />
          <strong className="mr-1 text-[14px] font-bold text-foreground">{rangeTitle(view, anchor, columns)}</strong>
          <button type="button" className="rounded-full border border-border bg-card px-3 py-1 text-[13px] font-medium text-foreground" onClick={() => setAnchor(DEMO_TODAY)}>
            Today
          </button>
          <span className="ml-auto">
            <FieldSingleSelect hideLabel variant="pill" label="Calendar view" value={view} onChange={(next) => setView(next as CalendarView)} options={CALENDAR_VIEWS} dataAttr="bookings-calendar-view" />
          </span>
        </div>

        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <div className="grid" style={{ gridTemplateColumns: template }}>
            <div className="flex items-center px-3 text-[12px] font-medium text-foreground">Room</div>
            {columns.map((d) => (
              <button
                type="button"
                key={d.toISOString()}
                aria-label={view === "year" ? MONTH_ABBR[d.getMonth()]! : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                onClick={() => {
                  if (view === "year") {
                    setAnchor(d);
                    setView("month");
                  } else onDay(d);
                }}
                className={`border-l border-border py-1.5 text-center hover:bg-accent/40 ${view !== "year" && [0, 6].includes(d.getDay()) ? "bg-[#f4f5f7]" : ""}`}
              >
                {view === "year" ? (
                  <div className="text-[11px] font-bold text-foreground">{MONTH_ABBR[d.getMonth()]}</div>
                ) : (
                  <>
                    <div className="text-[9px] font-medium text-muted">{WEEKDAY[d.getDay()]}</div>
                    <div className={`mx-auto mt-0.5 grid size-5 place-items-center rounded-full text-[11px] font-bold ${isToday(d) ? "bg-primary text-white" : "text-foreground"}`}>{d.getDate()}</div>
                  </>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-border bg-[#fbfbfc] px-3 py-2 text-[12px] text-foreground" data-attr="bookings-calendar-summary">
            {staying} staying · {checkIns} check-ins · {checkOuts} check-outs <span className="ml-2">{peak} of {beds} occupied · {Math.round((peak / beds) * 100)}%</span>
          </div>
          {OPS_HOUSES.map((house) => {
            const mine = rows.filter((r) => houseOf(r.place) === house.label);
            const rent = PROPERTY_ROWS.find((p) => p.title === house.label)?.rentLabel ?? "";
            const rooms = roomsOf(house.label);
            return (
              <div key={house.id} className="border-t border-border">
                {rooms.length > 1 ? <div className="bg-[#f0f4fe] px-3 py-1.5 text-[12px] font-semibold text-foreground">{house.label}</div> : null}
                {rooms.map((room) => {
                  const own = mine.filter((s) => (room === "Whole home" ? !s.place.includes("·") : s.place.endsWith(room)));
                  return (
                    <div key={room} className="relative grid items-center border-t border-border" style={{ gridTemplateColumns: template, minHeight: 34 }}>
                      <div className="px-3 text-[12px] text-foreground">
                        {room === "Whole home" ? house.label : room}
                        <span className="ml-1.5 text-muted">{rent}</span>
                      </div>
                      {columns.map((d) => (
                        <div key={d.toISOString()} className={`h-full border-l border-border ${view !== "year" && [0, 6].includes(d.getDay()) ? "bg-[#f4f5f7]" : ""}`} />
                      ))}
                      {own.map((stay) => {
                        const span = barSpan(stay.stay, columns, view);
                        if (!span) return null;
                        const channel = OPS_BOOKING_DETAILS[stay.id]?.isChannel;
                        return (
                          <DropdownMenu key={stay.id}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={`${stay.guest}, ${stay.status}`}
                                className={`absolute top-1 h-[26px] truncate rounded-lg px-2 text-left text-[11px] font-semibold ${BAR_COLOR[stay.status]}`}
                                style={{
                                  left: `calc(150px + (100% - 150px) * ${span.from} / ${columns.length} + 2px)`,
                                  width: `calc((100% - 150px) * ${span.to - span.from + 1} / ${columns.length} - 4px)`,
                                }}
                              >
                                {stay.guest}
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
                              <div className="grid gap-1 p-3 text-sm">
                                <strong>{stay.guest}</strong>
                                <span>{stay.stay}</span>
                                <span>{stay.place}</span>
                              </div>
                              {!channel ? <DropdownMenuItem onSelect={() => onEdit(stay)}>Edit</DropdownMenuItem> : null}
                              <DropdownMenuItem onSelect={() => onOpen(stay)}>Open booking</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-2 text-xs text-muted" aria-label="Calendar colours" data-attr="bookings-calendar-legend">
        {[
          ["Hold", "bg-[#f3d9a4]"],
          ["Confirmed", "bg-[#2f8a4b]"],
          ["In-house", "bg-[#1f55e0]"],
          ["Checked out", "bg-[#9aa3b2]"],
          ["Airbnb / Booking.com", "bg-[#a04a14]"],
        ].map(([label, dot]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BookingsPanel() {
  const [tab, setTab] = useState("calendar");
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState<string[]>([]);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BookingFixtureRow | null>(null);
  const [day, setDay] = useState<Date | null>(null);
  const [record, setRecord] = useState<{ row: BookingFixtureRow; section: string } | null>(null);
  const [cancelling, setCancelling] = useState<BookingFixtureRow | null>(null);
  const filterLabels = propertyFilter.map((id) => OPS_HOUSES.find((h) => h.id === id)?.label);
  const scoped = BOOKING_ROWS.filter((r) => !propertyFilter.length || filterLabels.includes(houseOf(r.place)));
  const counts = useMemo(() => countBy(scoped, (r) => r.bucket, ["upcoming", "inhouse", "past"]), [scoped]);
  const rows = scoped.filter((r) => r.bucket === tab && matchesSearch(search, r.guest, r.place));

  if (record) {
    return (
      <OpsRecordScreen path={`/portal/bookings/${record.row.id}`} toastNode={toastNode}>
        <DemoBookingRecord row={record.row} initialSection={record.section} onBack={() => setRecord(null)} toast={show} />
      </OpsRecordScreen>
    );
  }

  return (
    <FixtureListScreen
      path="/portal/bookings/calendar"
      title="Bookings"
      tabs={BOOKING_TABS.map((t) => ({ ...t, count: t.id === "calendar" ? undefined : counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search bookings"
      actions={
        <>
          <PropertyFilterSheet value={propertyFilter} onChange={setPropertyFilter} dataAttr="bookings-filter" />
          <IntegrationsAction toast={show} dataAttr="bookings-integrations" />
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("booking"), onClick: () => setAdding(true) }}
      surface={tab !== "calendar"}
      isEmpty={rows.length === 0}
      emptyTitle={portalEmptyCopy(`bookings.${tab === "calendar" ? "upcoming" : tab}` as "bookings.upcoming").title}
      emptySection="bookings"
      onBulkClear={selection.clear}
      overlay={
        <>
          {adding ? (
            <DemoBookingPopup
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                show("Booking added (sample)");
              }}
            />
          ) : null}
          {editing ? (
            <DemoBookingPopup
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                show("Booking saved (sample)");
              }}
            />
          ) : null}
          {day ? <DemoBookingDayDialog day={day} rows={scoped} onClose={() => setDay(null)} onOpen={(row) => { setDay(null); setRecord({ row, section: "overview" }); }} toast={show} /> : null}
          {cancelling ? (
            <DemoConfirmDialog
              title={OPS_BOOKING_DETAILS[cancelling.id]?.isChannel ? "Remove stay" : "Cancel booking"}
              body={`${OPS_BOOKING_DETAILS[cancelling.id]?.isChannel ? "Remove" : "Cancel"} ${cancelling.guest}'s stay at ${cancelling.place}? This cannot be undone.`}
              confirmLabel={OPS_BOOKING_DETAILS[cancelling.id]?.isChannel ? "Remove" : "Cancel booking"}
              onClose={() => setCancelling(null)}
              onConfirm={() => {
                setCancelling(null);
                show("Booking cancelled (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {tab === "calendar" ? (
        <BookingsCalendarCard rows={scoped} onOpen={(row) => setRecord({ row, section: "overview" })} onDay={setDay} onEdit={setEditing} />
      ) : (
        rows.map((r) => {
          const channel = OPS_BOOKING_DETAILS[r.id]?.isChannel;
          return (
            <BookingsRowOverflow
              key={r.id}
              label={r.guest}
              onEditDates={!channel ? () => setEditing(r) : undefined}
              onMessage={() => setRecord({ row: r, section: "communication" })}
              onCancel={() => setCancelling(r)}
              cancelLabel={channel ? "Remove stay" : undefined}
            >
              <PortalApplicantRecordRow
                name={r.guest}
                address={r.place}
                amount={r.rate}
                facts={
                  <>
                    <PortalRowFact icon={CalendarDays} srLabel="Dates">{r.stay}</PortalRowFact>
                    <PortalRowFact icon={STATUS_ICON[r.status]} srLabel="Status">{r.status}</PortalRowFact>
                    {r.source ? <PortalRowFact icon={Globe} srLabel="Source">{r.source}</PortalRowFact> : null}
                  </>
                }
                checked={selection.isChecked(r.id)}
                onSelectedChange={(checked) => selection.set(r.id, checked)}
                onOpen={() => setRecord({ row: r, section: "overview" })}
                omitActionView
                dataAttr="booking-list-row"
              />
            </BookingsRowOverflow>
          );
        })
      )}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Promotion ───────────────────────────── */

const SITE_GROUPS: { id: ListingChannelGroup; label: string }[] = [
  { id: "automatic", label: "Automatic" },
  { id: "one_click", label: "One-click" },
  { id: "request_access", label: "Request access" },
];
const SITE_TOTAL = SITE_GROUPS.reduce((sum, g) => sum + listingChannelsByGroup(g.id).length, 0);

/** Promotion > Listing sites, drawn from the real piece's own rows (`WorkspaceListingSitesPanel`): the Listed with PropLane toggle,
 * the Automatic / One-click / Request access group tabs, and one IntegrationRow per real channel with its plain fact. */
function DemoListingSites({ houses }: { houses: number }) {
  const [group, setGroup] = useState<ListingChannelGroup>("automatic");
  const [attribution, setAttribution] = useState(true);
  const listings = (n: number) => `${n} of ${houses} ${houses === 1 ? "listing" : "listings"}`;
  return (
    <div data-attr="promotion-listing-sites">
      <IntegrationRow
        icon={ProPlaneMarkIcon}
        tone="text-primary"
        name="Show Listed with PropLane"
        action={<PortalSettingsToggle checked={attribution} onChange={setAttribution} label="Show Listed with PropLane" />}
      />
      <div className="px-4 pb-1 pt-3">
        <LocalDestinationNav
          items={SITE_GROUPS.map((g) => ({ id: g.id, label: g.label, count: listingChannelsByGroup(g.id).length }))}
          activeId={group}
          onChange={(id) => setGroup(id as ListingChannelGroup)}
          ariaLabel="Listing site group"
          appearance="command"
        />
      </div>
      {listingChannelsByGroup(group).map((def) => {
        const glyph = CHANNEL_GLYPH[def.id];
        if (group === "automatic") {
          return def.id === "zillow" ? (
            <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact={`${listings(3)} posting`} />
          ) : (
            <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} comingSoon />
          );
        }
        if (group === "one_click") return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact={`${listings(0)} posted by me`} />;
        return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact="Coming soon" />;
      })}
    </div>
  );
}

/** The square 5.5 x 4.125 rem thumbnail tile a promotion row opens with (never a fabricated photo: a glyph when there is none). */
function PromotionRowTile({ row }: { row: PromotionFixtureRow }) {
  const Icon = row.bucket === "text" ? FileText : OPS_PROMOTION_DETAILS[row.id]?.kindId === "upload" ? ImageIcon : Megaphone;
  return (
    <div aria-hidden className="grid h-[4.125rem] w-[5.5rem] place-items-center rounded-[10px] bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-16">
      <Icon className="size-[22px]" strokeWidth={1.5} />
    </div>
  );
}

export function PromotionPanel() {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState<string[]>([]);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PromotionFixtureRow | null>(null);
  const [viewing, setViewing] = useState<PromotionFixtureRow | null>(null);
  const [deleting, setDeleting] = useState<PromotionFixtureRow | null>(null);
  const filterLabels = propertyFilter.map((id) => OPS_HOUSES.find((h) => h.id === id)?.label);
  const scoped = PROMOTION_ROWS.filter((r) => !propertyFilter.length || filterLabels.includes(r.place));
  const counts = { all: scoped.length, text: scoped.filter((r) => r.bucket === "text").length, image: scoped.filter((r) => r.bucket === "image").length, sites: SITE_TOTAL };
  const rows: PromotionFixtureRow[] = scoped.filter((r) => (tab === "all" || r.bucket === tab) && matchesSearch(search, r.title, r.place, r.kind));
  const selected = PROMOTION_ROWS.find((r) => r.id === selection.only);
  const canEdit = selected && (OPS_PROMOTION_DETAILS[selected.id]?.kindId === "flyer" || OPS_PROMOTION_DETAILS[selected.id]?.kindId === "text");
  const emptyKey = tab === "text" ? "promotion.text" : tab === "image" ? "promotion.image" : "promotion";

  return (
    <FixtureListScreen
      path="/portal/promotion"
      title="Promotion"
      tabs={[
        { id: "all", label: "All", count: counts.all },
        { id: "text", label: "Text", count: counts.text },
        { id: "image", label: "Image", count: counts.image },
        { id: "sites", label: "Listing sites", count: counts.sites },
      ]}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Promotion type"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search promotions"
      actions={
        <>
          <PropertyFilterSheet value={propertyFilter} onChange={setPropertyFilter} dataAttr="promotion-filter" />
          {tab === "sites" ? <IntegrationsAction toast={show} dataAttr="promotion-integrations" /> : null}
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("promotion"), onClick: () => setCreating(true) }}
      isEmpty={tab !== "sites" && rows.length === 0}
      emptyTitle={tab !== "sites" && rows.length === 0 && scoped.length === 0 && PROMOTION_ROWS.length > 0 ? portalEmptyNoMatchTitle("promotions") : portalEmptyCopy(emptyKey as "promotion").title}
      emptySection="promotion"
      menu={
        selected ? (
          <>
            {canEdit && selection.only ? <DropdownMenuItem onSelect={() => setEditing(selected)}>Edit</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => setDeleting(selected)} className="text-danger">
              Delete
            </DropdownMenuItem>
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {creating ? (
            <DemoPromotionNewPopup
              onClose={() => setCreating(false)}
              onSaved={(kind) => {
                setCreating(false);
                show(kind === "upload" ? "Promotion saved (sample)" : kind === "text" ? "Promotion text generated (sample)" : "Flyer generated (sample)");
              }}
            />
          ) : null}
          {editing ? (
            <DemoPromotionNewPopup
              editing={editing}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                show("Promotion saved (sample)");
              }}
            />
          ) : null}
          {viewing ? <DemoPromotionViewDialog row={viewing} onClose={() => setViewing(null)} toast={show} /> : null}
          {deleting ? (
            <DemoConfirmDialog
              title="Delete promotion"
              body={`Delete ${deleting.title}? This cannot be undone.`}
              confirmLabel="Delete"
              onClose={() => setDeleting(null)}
              onConfirm={() => {
                setDeleting(null);
                show("Promotion deleted (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {tab === "sites" ? (
        <DemoListingSites houses={PROPERTY_ROWS.length} />
      ) : (
        <div data-attr="promotion-list-rows">
          {rows.map((r) => (
            <PortalPropertyRecordRow
              key={r.id}
              title={r.title}
              address={r.place}
              leading={<PromotionRowTile row={r} />}
              leadingShape="square"
              facts={
                <>
                  <PortalRowFact icon={Megaphone} srLabel="Kind">{r.kind}</PortalRowFact>
                  <PortalRowFact icon={Clock} srLabel="Updated">{r.updated}</PortalRowFact>
                </>
              }
              checked={selection.isChecked(r.id)}
              onSelectedChange={(checked) => selection.set(r.id, checked)}
              selectLabel={r.title}
              onOpen={() => setViewing(r)}
              omitActionView
              dataAttr={`promotion-row-${r.id}`}
            />
          ))}
        </div>
      )}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Forms ───────────────────────────── */

const FORM_TABS = [
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
];

const FORM_KIND_OPTIONS = [
  { value: "intake", label: "Intake" },
  { value: "move-in", label: "Move-in" },
  { value: "move-out", label: "Move-out" },
  { value: "other", label: "Other" },
];
const FORM_BLOCKS_OPTIONS = [
  { value: "nothing", label: "Nothing" },
  { value: "move_in_details", label: "Move-in details" },
  { value: "lease_signing", label: "Lease signing" },
  { value: "approval", label: "Approval" },
];
const FORM_KIND_BY_TITLE: Record<string, string> = { "Intake form": "intake", "Move-in checklist": "move-in" };
const formKind = (form: ManagerFormFixture) => FORM_KIND_BY_TITLE[form.title] ?? "other";
const formBlocks = (form: ManagerFormFixture) =>
  form.blocks.includes("Move-in details") ? "move_in_details" : form.blocks.includes("Lease signing") ? "lease_signing" : form.blocks.includes("Approval") ? "approval" : "nothing";

/**
 * The real Forms page (`forms-list.tsx`): Pending · Completed tabs, search, the Filter popover (Kind, Property,
 * Resident, Blocks), the round + that opens "Send a move-in form", rows that open the form's record (answers and
 * activity, or "Not submitted yet" with Remind), and a ⋯ of Edit · Remind · Cancel request (pending) or
 * View · Download PDF (completed). Edit opens the real Edit form pop-up. Nothing is sent or saved.
 */
export function FormsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<ManagerFormFixture["bucket"]>("pending");
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [propertyNames, setPropertyNames] = useState<string[]>([]);
  const [residentNames, setResidentNames] = useState<string[]>([]);
  const [blocksFilter, setBlocksFilter] = useState<string[]>([]);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<ManagerFormFixture | null>(null);
  const [editing, setEditing] = useState<ManagerFormFixture | null>(null);
  const counts = useMemo(() => countBy(MANAGER_FORMS, (r) => r.bucket, ["pending", "completed"]), []);
  const propertyOptions = useMemo(
    () => [...new Set(MANAGER_FORMS.map((f) => f.place.split(" · ")[0]!))].sort().map((value) => ({ value, label: value })),
    [],
  );
  const residentOptions = useMemo(
    () => [...new Set(MANAGER_FORMS.map((f) => f.resident))].sort().map((value) => ({ value, label: value })),
    [],
  );
  const filtersActive = kinds.length + propertyNames.length + residentNames.length + blocksFilter.length;
  const rows = MANAGER_FORMS.filter(
    (r) =>
      r.bucket === tab &&
      matchesSearch(search, r.title, r.resident, r.place) &&
      (!kinds.length || kinds.includes(formKind(r))) &&
      (!propertyNames.length || propertyNames.includes(r.place.split(" · ")[0]!)) &&
      (!residentNames.length || residentNames.includes(r.resident)) &&
      (!blocksFilter.length || blocksFilter.includes(formBlocks(r))),
  );
  const selectedForm = MANAGER_FORMS.find((f) => f.id === selection.only);
  const menuItems = (form: ManagerFormFixture) => (
    <>
      {form.bucket === "completed" ? (
        <>
          <DropdownMenuItem onSelect={() => setViewing(form)}>View</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => show("Download PDF (sample)")}>Download PDF</DropdownMenuItem>
        </>
      ) : (
        <>
          <DropdownMenuItem onSelect={() => setEditing(form)}>Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => show(`Reminder sent to ${form.resident.split(" ")[0]} (sample)`)}>Remind</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => show("Request cancelled (sample)")} className="text-danger">
            Cancel request
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  return (
    <FixtureListScreen
      path="/portal/forms"
      title="Forms"
      tabs={FORM_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as ManagerFormFixture["bucket"]);
        selection.clear();
      }}
      tabAriaLabel="Forms"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search forms"
      actions={
        <DemoFilterSheet
          activeCount={portalFilterActiveCount([kinds, propertyNames, residentNames, blocksFilter])}
          compactPanel
          commandStripTrigger
          filterFieldCount={4}
          className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
          onReset={() => {
            setKinds([]);
            setPropertyNames([]);
            setResidentNames([]);
            setBlocksFilter([]);
          }}
          dataAttr="forms-filter-open"
        >
          <CheckboxMultiSelect label="Kind" variant="cell" options={FORM_KIND_OPTIONS} selected={kinds} onChange={setKinds} emptyLabel="All kinds" dataAttr="forms-filter-kind" />
          <CheckboxMultiSelect label="Property" variant="cell" options={propertyOptions} selected={propertyNames} onChange={setPropertyNames} emptyLabel="All properties" dataAttr="forms-filter-property" />
          <CheckboxMultiSelect label="Resident" variant="cell" options={residentOptions} selected={residentNames} onChange={setResidentNames} emptyLabel="All residents" dataAttr="forms-filter-resident" />
          <CheckboxMultiSelect label="Blocks" variant="cell" options={FORM_BLOCKS_OPTIONS} selected={blocksFilter} onChange={setBlocksFilter} emptyLabel="Anything" dataAttr="forms-filter-blocks" />
        </DemoFilterSheet>
      }
      primary={{ label: portalListAddPrimaryLabel("form"), onClick: () => setSending(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        rows.length === 0 && counts[tab] > 0 && (search.trim() || filtersActive)
          ? portalEmptyNoMatchTitle("forms", search)
          : portalEmptyCopy(tab === "pending" ? "forms.pending" : "forms.completed").title
      }
      emptySection="forms"
      menu={selectedForm ? menuItems(selectedForm) : undefined}
      onBulkClear={selection.clear}
      overlay={
        <>
          {sending ? (
            <DemoSendFormPopup
              onClose={() => setSending(false)}
              onSent={() => {
                setSending(false);
                show("Form sent (sample)");
              }}
            />
          ) : null}
          {viewing ? <DemoFormViewerPopup form={viewing} onClose={() => setViewing(null)} onRemind={(first) => { setViewing(null); show(`Reminder sent to ${first} (sample)`); }} /> : null}
          {editing ? (
            <DemoEditPendingFormPopup
              form={editing}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                show("Form updated (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalEntryRow
          key={r.id}
          tile={{ kind: "initials", label: r.resident }}
          title={r.title}
          place={`${r.resident} · ${r.place}`}
          facts={[
            { icon: r.blocks === "Blocks nothing" ? Unlock : Lock, label: r.blocks },
            {
              icon: tab === "completed" ? CheckCircle2 : Clock,
              label: r.late ? <span className="font-medium text-[var(--status-overdue-fg)]">{r.when}</span> : r.when,
            },
          ]}
          checked={selection.isChecked(r.id)}
          onSelectedChange={(checked) => selection.set(r.id, checked)}
          onOpen={() => setViewing(r)}
          omitActionView
          selectLabel={r.title}
          dataAttr="forms-row"
        />
      ))}
    </FixtureListScreen>
  );
}


/* ───────────────────────────── Outgoing payments ───────────────────────────── */

const OUTGOING_TABS = [
  { id: "to-pay", label: "To pay" },
  { id: "scheduled", label: "Scheduled" },
  { id: "paid", label: "Paid" },
];
const METHOD_ICON: Record<OutgoingFixtureRow["method"], LucideIcon> = { "PropLane balance": Wallet, Bank: Landmark, "Card or bank account": Banknote };
const money2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The list page frame with the money stat strip INSIDE the control stack, where the real Outgoing payments page draws it. */
function OutgoingListScreen({
  tabs,
  activeId,
  onTab,
  search,
  onSearch,
  actions,
  primary,
  stats,
  isEmpty,
  emptyTitle,
  menu,
  onBulkClear,
  overlay,
  children,
}: {
  tabs: FixtureTab[];
  activeId: string;
  onTab: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  actions: ReactNode;
  primary: { label: string; onClick: () => void };
  stats: ReactNode;
  isEmpty: boolean;
  emptyTitle: string;
  menu: ReactNode;
  onBulkClear: () => void;
  overlay: ReactNode;
  children: ReactNode;
}) {
  return (
    <ProductWindow path="/portal/outgoing/to-pay">
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Outgoing payments" titleInlineFilter={null} hideTitleOnMobileNav compactFilterRow>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinationRow={<LocalDestinationNav appearance="command" ariaLabel="Outgoing payments" items={tabs} activeId={activeId} onChange={onTab} />}
            stats={stats}
            search={{ value: search, onChange: onSearch, placeholder: "Search outgoing payments" }}
            actions={actions}
            primary={<PortalPrimaryIconAction label={primary.label} onClick={primary.onClick} />}
          />
          <PortalRecordListSurface isEmpty={isEmpty} emptyCard={{ title: emptyTitle, section: "payments" }} bulkActions={menu} onBulkClear={onBulkClear}>
            {children}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      {overlay}
    </ProductWindow>
  );
}

type OutgoingDialogKind = "view" | "pay" | "schedule" | "offline" | "delete";

export function OutgoingPaymentsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<OutgoingFixtureRow["bucket"]>("to-pay");
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [adding, setAdding] = useState(false);
  const [record, setRecord] = useState<OutgoingFixtureRow | null>(null);
  const [dialog, setDialog] = useState<{ kind: OutgoingDialogKind; row: OutgoingFixtureRow } | null>(null);
  const filtered = OUTGOING_ROWS.filter((r) => (!vendorFilter || r.vendor === vendorFilter) && (!propertyFilter || houseOf(r.property) === propertyFilter));
  const counts = useMemo(() => countBy(filtered, (r) => r.bucket, OUTGOING_TABS.map((t) => t.id)), [filtered]);
  const totals = (id: string) => filtered.filter((r) => r.bucket === id).reduce((sum, r) => sum + cents(r.amount), 0);
  const rows = filtered.filter((r) => r.bucket === tab && matchesSearch(search, r.vendor, r.detail, r.property));
  const vendorOptions = [...new Set(OUTGOING_ROWS.map((r) => r.vendor))].map((value) => ({ value, label: value }));
  const propertyOptions = [...new Set(OUTGOING_ROWS.map((r) => houseOf(r.property)))].map((value) => ({ value, label: value }));
  const selected = OUTGOING_ROWS.find((r) => r.id === selection.only);
  const planned = selected ? selected.bucket !== "paid" : false;

  if (record) {
    return (
      <OpsRecordScreen path={`/portal/outgoing/${record.bucket}/${record.id}`} toastNode={toastNode}>
        <DemoOutgoingRecord row={record} onBack={() => setRecord(null)} toast={show} />
      </OpsRecordScreen>
    );
  }

  return (
    <OutgoingListScreen
      tabs={OUTGOING_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as OutgoingFixtureRow["bucket"]);
        selection.clear();
      }}
      search={search}
      onSearch={setSearch}
      actions={
        <DemoFilterSheet
          activeCount={portalFilterActiveCount([vendorFilter, propertyFilter])}
          compactPanel
          commandStripTrigger
          filterFieldCount={2}
          onReset={() => {
            setVendorFilter("");
            setPropertyFilter("");
          }}
          dataAttr="outgoing-filter"
        >
          <FieldSingleSelect label="Vendor" value={vendorFilter} onChange={setVendorFilter} options={[{ value: "", label: "All vendors" }, ...vendorOptions]} dataAttr="outgoing-filter-vendor" />
          <FieldSingleSelect label="Property" value={propertyFilter} onChange={setPropertyFilter} options={[{ value: "", label: "All properties" }, ...propertyOptions]} dataAttr="outgoing-filter-property" />
        </DemoFilterSheet>
      }
      primary={{ label: "Add payment", onClick: () => setAdding(true) }}
      stats={<PortalStatStrip dataAttr="outgoing-stat-strip" items={OUTGOING_TABS.map((t) => ({ id: t.id, label: t.label, value: money2(totals(t.id)), dataAttr: `outgoing-stat-${t.id}` }))} />}
      isEmpty={rows.length === 0}
      emptyTitle={
        search.trim() ? portalEmptyNoMatchTitle("payments", search) : tab === "to-pay" ? "Nothing to pay" : tab === "scheduled" ? "Nothing scheduled" : "No payments yet"
      }
      menu={
        selected ? (
          <>
            {planned ? <DropdownMenuItem onSelect={() => setDialog({ kind: "pay", row: selected })}>Pay now</DropdownMenuItem> : null}
            {planned ? <DropdownMenuItem onSelect={() => setDialog({ kind: "schedule", row: selected })}>{selected.bucket === "scheduled" ? "Change date" : "Schedule payment"}</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => setDialog({ kind: "view", row: selected })}>View invoice</DropdownMenuItem>
            {planned ? <DropdownMenuItem onSelect={() => setDialog({ kind: "offline", row: selected })}>Mark paid</DropdownMenuItem> : null}
            {OPS_OUTGOING_DETAILS[selected.id]?.managerEntered && planned ? (
              <DropdownMenuItem className="text-[var(--status-overdue-fg)] focus:text-[var(--status-overdue-fg)]" onSelect={() => setDialog({ kind: "delete", row: selected })}>
                Delete bill
              </DropdownMenuItem>
            ) : null}
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {adding ? (
            <DemoOutgoingAddPopup
              onClose={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                show("Payment added (sample)");
              }}
            />
          ) : null}
          {dialog ? (
            <DemoOutgoingDialog
              kind={dialog.kind}
              row={dialog.row}
              onClose={() => setDialog(null)}
              onDone={(text) => {
                setDialog(null);
                show(text);
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.vendor}
          tileLabel={r.vendor}
          address={`${r.detail} · ${r.property}`}
          omitActionView
          facts={
            <>
              <PortalRowFact icon={tab === "paid" ? CalendarDays : Clock}>{r.when}</PortalRowFact>
              <PortalRowFact icon={METHOD_ICON[r.method]}>{r.method}</PortalRowFact>
            </>
          }
          trailing={<strong>{r.amount}</strong>}
          checked={selection.isChecked(r.id)}
          onSelectedChange={(checked) => selection.set(r.id, checked)}
          selectLabel={`${r.vendor} · ${r.detail}`}
          onOpen={() => setRecord(r)}
          dataAttr="outgoing-invoice-row"
        />
      ))}
    </OutgoingListScreen>
  );
}

/* ───────────────────────────── Finances ───────────────────────────── */

const FINANCE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "reports", label: "Reports" },
];
const REPORT_ICON: Record<string, LucideIcon> = {
  "income-statement": TrendingUp,
  profitability: Building2,
  "financial-activity": BookOpen,
  "cash-flow-statement": TrendingUp,
  "trial-balance": Scale,
  "balance-sheet": Landmark,
  "general-ledger": BookOpen,
  "owner-statement": Building2,
  "owner-distributions": Wallet,
  "budget-vs-actual": ClipboardList,
  "security-deposits": PiggyBank,
  "trust-account-balance": ShieldCheck,
  bills: Receipt,
  "ap-aging": FileSpreadsheet,
  "payout-history": Landmark,
  "bank-reconciliation": Scale,
  "financial-diagnostics": Stethoscope,
};

/** Overview figures read as whole dollars, like the studio ("$7,700"). */
const whole = (n: number) => usd(n);

/** Twelve months of the demo's cash flow, ending September: the same shape the Dashboard's chart draws. */
const FINANCE_POINTS: MonthlyCashflowPoint[] = [
  [0, 0], [0, 0], [1650, 0], [1650, 900], [2100, 1000], [1700, 1300], [2300, 1400], [2800, 1500], [3300, 2100], [4300, 2500], [6600, 2200], [8950, 655],
].map(([revenue, expense], index) => {
  const at = new Date(2024, 9 + index, 1);
  return {
    key: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`,
    label: at.toLocaleString("en-US", { month: "short" }),
    revenue: revenue!,
    expense: expense!,
    profit: revenue! - expense!,
  };
});
const CURRENT_MONTH = FINANCE_POINTS[FINANCE_POINTS.length - 1]!.key;
const monthLabel = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" });

export function FinancesPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const [tab, setTab] = useState("overview");
  const [month, setMonth] = useState(CURRENT_MONTH);
  const { show, node: toastNode } = useFixtureToast();
  const [chooser, setChooser] = useState(false);
  const [entry, setEntry] = useState<"expense" | "income" | null>(null);
  const [report, setReport] = useState<OpsReport | null>(null);
  const toPay = OUTGOING_ROWS.filter((r) => r.bucket === "to-pay");
  const pending = world.payments.filter((p) => p.bucket === "pending" || p.bucket === "overdue").reduce((sum, p) => sum + cents(p.amount), 0);
  const collected = world.payments.filter((p) => p.bucket === "paid").reduce((sum, p) => sum + cents(p.amount), 0);
  const point = FINANCE_POINTS.find((p) => p.key === month) ?? FINANCE_POINTS[FINANCE_POINTS.length - 1]!;
  const showByProperty = month === CURRENT_MONTH;

  if (report) {
    return (
      <OpsRecordScreen path={`/portal/financials/${report.id}`} toastNode={toastNode}>
        <DemoReportPage report={report} onBack={() => setReport(null)} toast={show} />
      </OpsRecordScreen>
    );
  }

  return (
    <FixtureListScreen
      path="/portal/financials/overview"
      title="Finances"
      tabs={FINANCE_TABS}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Finance view"
      actions={tab === "overview" ? <BalancePayoutsAction toast={show} /> : undefined}
      primary={tab === "overview" ? { label: "Add financial entry", onClick: () => setChooser(true) } : undefined}
      surface={tab === "reports"}
      isEmpty={false}
      emptyTitle="No entries yet"
      emptySection="financials"
      overlay={
        <>
          {chooser ? (
            <DemoFinancialEntryDialog
              onClose={() => setChooser(false)}
              onContinue={(kind) => {
                setChooser(false);
                setEntry(kind);
              }}
            />
          ) : null}
          {entry === "expense" ? (
            <DemoExpensePopup
              onClose={() => setEntry(null)}
              onSaved={() => {
                setEntry(null);
                show("Expense saved (sample)");
              }}
            />
          ) : null}
          {entry === "income" ? (
            <DemoIncomePopup
              onClose={() => setEntry(null)}
              onSaved={() => {
                setEntry(null);
                show("Income saved (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {tab === "overview" ? (
        <div className="space-y-4 pb-6" data-attr="finances-overview">
          <PortalStatStrip
            size="lg"
            dataAttr="finances-balance-strip"
            items={[
              { id: "available", label: "Available", value: whole(collected + 8800) },
              { id: "pending", label: "Pending", value: whole(pending) },
              { id: "held", label: "Held deposits", value: whole(RESIDENT_DEPOSITS) },
              { id: "to-pay", label: "To pay", value: whole(toPay.reduce((sum, r) => sum + cents(r.amount), 0)), note: `${toPay.length} ${toPay.length === 1 ? "bill" : "bills"}` },
            ]}
          />
          <div className="flex items-center gap-2">
            <FieldSingleSelect
              hideLabel
              label="Month"
              value={month}
              onChange={setMonth}
              wrapperClassName="relative inline-block"
              triggerClassName={FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS}
              dataAttr="finances-month"
              options={[...FINANCE_POINTS].reverse().map((p) => ({ value: p.key, label: monthLabel(p.key) }))}
            />
          </div>
          <PortalStatStrip
            size="lg"
            dataAttr="finances-month-strip"
            className="[grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]"
            items={[
              { id: "revenue", label: "Revenue", value: whole(point.revenue), tone: point.revenue > 0 ? "ok" : undefined },
              { id: "expenses", label: "Expenses", value: whole(point.expense) },
              { id: "profit", label: "Profit", value: whole(point.profit), tone: point.profit > 0 ? "ok" : undefined },
            ]}
          />
          {showByProperty ? (
            <section className="overflow-hidden rounded-[10px] border border-border bg-card" data-attr="finances-by-property">
              <h3 className="border-b border-border px-4 py-2.5 text-[14px] font-semibold text-foreground">By property</h3>
              <PortalListGroupRowContext.Provider value>
                {FINANCE_BY_PROPERTY.map((p) => (
                  <PortalPropertyRecordRow
                    key={p.id}
                    title={p.title}
                    leading={<PortalRowIconTile icon={Building2} />}
                    leadingShape="square"
                    facts={
                      <>
                        <span className="font-medium text-[var(--status-confirmed-fg)]">In {whole(p.in)}</span>
                        <span>Out {whole(p.out)}</span>
                      </>
                    }
                    dataAttr="finances-by-property-row"
                  />
                ))}
              </PortalListGroupRowContext.Provider>
            </section>
          ) : null}
          <MonthlyProfitChart points={FINANCE_POINTS} onMonthSelect={setMonth} />
        </div>
      ) : (
        <div data-attr="finances-reports">
          {OPS_REPORTS.map((r) => {
            const open = () => (r.download ? show(`${r.label} downloaded (sample)`) : setReport(r));
            return (
              <div key={r.id} data-attr={`finances-report-${r.id}`}>
                <PortalPropertyRecordRow
                  title={r.label}
                  leading={<PortalRowIconTile icon={REPORT_ICON[r.id] ?? FileSpreadsheet} />}
                  leadingShape="square"
                  onOpen={open}
                  dataAttr="finances-report-row"
                  actions={
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" aria-label={`${r.label} actions`} className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}>
                          <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={open}>View</DropdownMenuItem>
                        {["CSV", "PDF"].map((format) => (
                          <DropdownMenuItem key={format} onSelect={() => show(`Download ${format} (sample)`)}>
                            Download {format}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </FixtureListScreen>
  );
}

/** Security deposits the sample workspace holds: one month's rent per current resident, from the rows the Residents tab draws. */
const RESIDENT_DEPOSITS = PROPERTY_ROWS.reduce((sum, p) => sum + Number(p.rentLabel.replace(/[^0-9]/g, "")) * Math.min(p.rooms, 2), 0);

/* ───────────────────────────── Documents ───────────────────────────── */

const DOCUMENT_TABS = [
  { id: "applications", label: "Applications" },
  { id: "leases", label: "Leases" },
  { id: "other", label: "Other documents" },
];

/** The Property field Applications and Leases carry (`LeasingDocumentsFilterFields`): All properties first. */
function LeasingPropertyField({ value, onChange, dataAttr }: { value: string; onChange: (next: string) => void; dataAttr: string }) {
  const options = [{ value: "", label: "All properties" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))];
  const [draft, setDraft] = usePortalFilterDraft(value, onChange, "");
  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection sectionId="property" label="Property" summary={filterSingleSelectSummary(draft, options, "All properties")} empty={!draft} menuOptionCount={options.length} dataAttr={`${dataAttr}-trigger`}>
        <FilterSingleSelectList options={options} value={draft} onChange={setDraft} dataAttr={dataAttr} />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}

type LibraryFilters = { search: string; category: string; scope: string; property: string; expiry: string };
const LIBRARY_FILTERS_DEFAULT: LibraryFilters = { search: "", category: "", scope: "", property: "", expiry: "" };

/** The Other documents Filter fields (`DocumentLibraryFilterFields`): Expiry window, search, Category, Scope, Property. */
function LibraryFilterFields({ filters, onChange }: { filters: LibraryFilters; onChange: (patch: Partial<LibraryFilters>) => void }) {
  const [category, setCategory] = usePortalFilterDraft(filters.category, (v) => onChange({ category: v }), "");
  const [scope, setScope] = usePortalFilterDraft(filters.scope, (v) => onChange({ scope: v }), "");
  const [property, setProperty] = usePortalFilterDraft(filters.property, (v) => onChange({ property: v }), "");
  const [expiry, setExpiry] = usePortalFilterDraft(filters.expiry, (v) => onChange({ expiry: v }), "");
  const categoryOptions = [{ value: "", label: "All categories" }, ...OPS_DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: c }))];
  const scopeOptions = OPS_DOCUMENT_SCOPES.map((s) => ({ value: s.id, label: s.label }));
  const propertyOptions = [{ value: "", label: "All properties" }, ...OPS_HOUSES.map((h) => ({ value: h.id, label: h.label }))];
  const others = DOCUMENT_ROWS.filter((r) => r.bucket === "other");
  const pills = [
    { id: "", label: "All", count: others.length },
    { id: "expired", label: "Expired", count: 0 },
    { id: "expiring30", label: "Expiring ≤30d", count: 0 },
    { id: "expiring90", label: "Expiring ≤90d", count: 0 },
  ];
  return (
    <FilterFieldsAccordion>
      <div className="flex flex-col gap-3">
        <LocalDestinationNav appearance="command" items={pills} activeId={expiry} onChange={setExpiry} ariaLabel="Expiry window" />
        <Input type="search" value={filters.search} onChange={(e) => onChange({ search: e.target.value })} placeholder="Search by name…" className="h-10 w-full text-sm" aria-label="Search documents" data-attr="document-search" />
        <FilterCollapsibleSection sectionId="document-category" label="Category" summary={filterSingleSelectSummary(category, categoryOptions, "All categories")} empty={!category} menuOptionCount={categoryOptions.length} dataAttr="document-filter-category-trigger">
          <FilterSingleSelectList options={categoryOptions} value={category} onChange={setCategory} dataAttr="document-filter-category" />
        </FilterCollapsibleSection>
        <FilterCollapsibleSection sectionId="document-scope" label="Scope" summary={filterSingleSelectSummary(scope, scopeOptions, "All scopes")} empty={!scope} menuOptionCount={scopeOptions.length} dataAttr="document-filter-scope-trigger">
          <FilterSingleSelectList options={scopeOptions} value={scope} onChange={setScope} dataAttr="document-filter-scope" />
        </FilterCollapsibleSection>
        <FilterCollapsibleSection sectionId="document-property" label="Property" summary={filterSingleSelectSummary(property, propertyOptions, "All properties")} empty={!property} menuOptionCount={propertyOptions.length} dataAttr="document-filter-property-trigger">
          <FilterSingleSelectList options={propertyOptions} value={property} onChange={setProperty} dataAttr="document-filter-property" />
        </FilterCollapsibleSection>
      </div>
    </FilterFieldsAccordion>
  );
}

export function DocumentsPanel({ story }: { story?: DemoStory } = {}) {
  void story;
  const [tab, setTab] = useState<DocumentFixtureRow["bucket"]>("applications");
  const [leasingProperty, setLeasingProperty] = useState("");
  const [library, setLibrary] = useState<LibraryFilters>(LIBRARY_FILTERS_DEFAULT);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [uploading, setUploading] = useState(false);
  const [openApplication, setOpenApplication] = useState<DocumentFixtureRow | null>(null);
  const [leasePreview, setLeasePreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<DocumentFixtureRow | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const patchLibrary = (next: Partial<LibraryFilters>) => setLibrary((current) => ({ ...current, ...next }));
  const propertyMatch = (r: DocumentFixtureRow, property: string) => !property || OPS_DOC_HOUSE[r.id] === property;
  const leasing = DOCUMENT_ROWS.filter((r) => propertyMatch(r, leasingProperty));
  const otherRows = DOCUMENT_ROWS.filter(
    (r) =>
      r.bucket === "other" &&
      matchesSearch(library.search, r.title, r.meta) &&
      (!library.category || OPS_OTHER_DOCUMENTS[r.id]?.category === library.category) &&
      (!library.scope || (library.scope === "property" ? OPS_OTHER_DOCUMENTS[r.id]?.propertyScoped : library.scope === "manager" ? !OPS_OTHER_DOCUMENTS[r.id]?.propertyScoped : false)) &&
      propertyMatch(r, library.property),
  );
  const counts = {
    applications: leasing.filter((r) => r.bucket === "applications").length,
    leases: leasing.filter((r) => r.bucket === "leases").length,
    other: DOCUMENT_ROWS.filter((r) => r.bucket === "other").length,
  };
  const rows = tab === "other" ? otherRows : leasing.filter((r) => r.bucket === tab);
  const libraryActive = portalFilterActiveCount([library.category, library.scope, library.property, library.expiry]);
  const exportLabel = selection.selected.size > 1 ? `Export (${selection.selected.size})` : "Export";
  const emptyKey = `documents.${tab === "applications" ? "applications" : tab === "leases" ? "leases" : "other"}`;

  if (openApplication) {
    return (
      <OpsRecordScreen path={`/portal/documents/applications/${openApplication.id}`} toastNode={toastNode}>
        <DemoApplicationDocRecord row={openApplication} onBack={() => setOpenApplication(null)} toast={show} />
      </OpsRecordScreen>
    );
  }

  const listRows = rows.map((r) => ({
    id: r.id,
    data: r,
    primary: r.title,
    meta: r.meta,
    trailing: r.trailing ? <span className={tab === "applications" ? "hidden text-xs text-muted sm:inline" : "text-xs text-muted tabular-nums"}>{r.trailing}</span> : undefined,
    selected: selection.isChecked(r.id),
    onSelectedChange: (checked: boolean) => selection.set(r.id, checked),
    onClick: () => (tab === "applications" ? setOpenApplication(r) : setLeasePreview((current) => (current === r.id ? null : r.id))),
    expanded: tab === "leases" && leasePreview === r.id,
    expandedContent: tab === "leases" && leasePreview === r.id ? <DemoLeaseInlinePreview row={r} toast={show} /> : undefined,
  }));

  return (
    <FixtureListScreen
      path="/portal/documents/applications"
      title="Documents"
      tabs={DOCUMENT_TABS.map((t) => ({ ...t, count: counts[t.id as keyof typeof counts] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as DocumentFixtureRow["bucket"]);
        selection.clear();
      }}
      tabAriaLabel="Documents"
      actions={
        <DemoFilterSheet
          activeCount={tab === "other" ? libraryActive : portalFilterActiveCount([leasingProperty])}
          compactPanel
          commandStripTrigger
          filterFieldCount={tab === "other" ? 4 : 1}
          onReset={() => {
            if (tab === "other") setLibrary(LIBRARY_FILTERS_DEFAULT);
            else setLeasingProperty("");
          }}
          dataAttr="documents-filter"
        >
          {tab === "other" ? <LibraryFilterFields filters={library} onChange={patchLibrary} /> : <LeasingPropertyField value={leasingProperty} onChange={setLeasingProperty} dataAttr={`documents-${tab}-filter-property`} />}
        </DemoFilterSheet>
      }
      primary={{ label: portalListAddPrimaryLabel("document"), onClick: () => setUploading(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        rows.length === 0 && (tab === "other" ? libraryActive || library.search.trim() : leasingProperty)
          ? portalEmptyNoMatchTitle(tab === "applications" ? "application documents" : tab === "leases" ? "lease documents" : "documents", library.search)
          : portalEmptyCopy(emptyKey as "documents.other").title
      }
      emptySection="documents"
      menu={
        tab !== "other" && selection.selected.size > 0 ? (
          <DropdownMenuItem
            onSelect={() => {
              show(`${exportLabel} (sample)`);
              selection.clear();
            }}
          >
            {exportLabel}
          </DropdownMenuItem>
        ) : undefined
      }
      onBulkClear={tab !== "other" ? selection.clear : undefined}
      overlay={
        <>
          {uploading ? (
            <DemoUploadDocumentPopup
              onClose={() => setUploading(false)}
              onSaved={() => {
                setUploading(false);
                show("Document uploaded (sample)");
              }}
            />
          ) : null}
          {previewing ? <DemoDocumentPreviewDialog row={previewing} onClose={() => setPreviewing(null)} toast={show} /> : null}
          {toastNode}
        </>
      }
    >
      {tab === "other"
        ? otherRows.map((r) => {
            const meta = OPS_OTHER_DOCUMENTS[r.id];
            return (
              <PortalServiceRecordRow
                key={r.id}
                title={r.title}
                subtitle={r.meta}
                onOpen={() => setPreviewing(r)}
                menu={
                  meta?.propertyScoped ? (
                    <RowActionsMenu
                      label={r.title}
                      items={[
                        {
                          id: "owner-sharing",
                          label: shared.has(r.id) ? "Stop sharing" : "Share with owners",
                          onSelect: () => {
                            setShared((current) => {
                              const next = new Set(current);
                              if (next.has(r.id)) next.delete(r.id);
                              else next.add(r.id);
                              return next;
                            });
                            show(`${shared.has(r.id) ? "Stopped sharing" : "Shared with owners"} (sample)`);
                          },
                        },
                      ]}
                    />
                  ) : undefined
                }
                dataAttr={`document-row-${r.id}`}
              />
            );
          })
        : <DataList hideColumnHeaders selectable rows={listRows} columns={[{ id: "name", header: "Name", cell: (row: DocumentFixtureRow) => row.title }]} />}
    </FixtureListScreen>
  );
}
