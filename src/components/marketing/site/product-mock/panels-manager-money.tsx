"use client";

/**
 * Manager Payments (incoming), Services and Communication panels for the home demo, split out of
 * `panels.tsx` (which re-exports them) so the pop-up work on these three tabs does not collide with
 * Tours / Applications / Leases. Same contract: the real page's structure (tabs, header icons, filter popover,
 * the round blue +, row anatomy, row menu) fed `fixtures.ts`; the pop-ups and record pages a row or the + opens are
 * `demo-popups-money.tsx`, loaded on demand. Nothing saves or fetches.
 * Sources: `pro-payments`, `pro-payments-ledger-panel`, `pro-all-services-panel`, `manager-service-row-menu`,
 * `pro-communication`, `pro-unified-inbox`, `pro-inbox`.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Ban,
  CalendarDays,
  CircleCheck,
  Clock,
  Info,
  MailOpen,
  MessageSquarePlus,
  Phone,
  Plug,
  Settings,
  Trash2,
  UserCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalStatStrip, type PortalStat } from "@/components/portal/portal-stat-strip";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PaymentFilterSortFields, type PaymentListSort } from "@/components/portal/payment-filter-sort-fields";
import { CommunicationFilterSortFields } from "@/components/portal/communication-filter-sort-fields";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalListResidentField } from "@/components/portal/portal-list-group-filter-fields";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { ManagerServiceCardRow } from "@/components/portal/pro-service-card-row";
import { ServiceListRowMenu } from "@/components/portal/service-list-row-menu";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  INBOX_THREAD_ICON_BTN,
  INBOX_THREAD_ICON_BTN_DANGER,
  InboxComposer,
  InboxConversationRow,
  InboxListHeader,
  InboxListSegmentTabs,
  InboxThreadView,
  InboxTwoPane,
} from "@/components/portal/portal-inbox-ui";
import { formatCentsAsUsd, sumMoneyLabelsCents } from "@/lib/money-label-totals";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { DEFAULT_PORTAL_LIST_GROUP_MODE, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import {
  EMPTY_COMMUNICATION_THREAD_FILTERS,
  roleLabel,
  type CommunicationFilterRole,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import type { CommunicationListSort } from "@/lib/unified-inbox-merge";
import { SERVICE_STAGE_TABS, type ServiceStage } from "@/lib/service-stage-ids";
import {
  COMM_CONVERSATIONS,
  type CommConversationFixture,
  type PaymentFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  ASSIGNED_SERVICE_ROWS,
  COMM_CONTACTS,
  PAY_SORT_OPTIONS,
  commSubtitle,
  moneyServiceRow,
  moneyToNumber,
  paymentDueMs,
  paymentPropertyOptions,
  paymentResidentOptions,
  serviceAssigneeOptions,
  serviceMatchesAssignee,
  serviceMenuItems,
  type MoneyServiceRow,
} from "@/components/marketing/site/product-mock/fixtures-popups-money";
import {
  DemoAddChargePopup,
  DemoAddServicePopup,
  DemoEditPaymentPopup,
  DemoNewMessagePopup,
  DemoPaymentRecordView,
  DemoServiceRecordView,
  preloadMoneyPopups,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-money";
import { FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { DEMO_PAGE_CLASS, DemoTarget, PortalSidebarFixture, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/** A panel mounted while the story is running keeps showing Jordan's row: when the
 * story moves his record to another tab, the panel follows it. */
function useFollow<T>(target: T | null, set: (value: T) => void) {
  useEffect(() => {
    if (target !== null) set(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
}

/** Starts the pop-up chunk once the panel is on screen, so a row click does not wait for the network. */
function usePreloadPopups() {
  useEffect(() => {
    preloadMoneyPopups();
  }, []);
}

/* ───────────────────────────── Payments ───────────────────────────── */

type PaymentBucket = PaymentFixtureRow["bucket"];

/** `PAY_LABELS` in pro-payments.tsx. */
const PAYMENT_TABS: { id: PaymentBucket; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
];
const DEMO_TODAY_MS = Date.UTC(2025, 8, 25);

function sortPayments(rows: PaymentFixtureRow[], bucket: PaymentBucket, sort: PaymentListSort): PaymentFixtureRow[] {
  const paid = bucket === "paid";
  return [...rows].sort((a, b) => {
    switch (sort) {
      case "dueSoon":
        return paid ? paymentDueMs(b) - paymentDueMs(a) : paymentDueMs(a) - paymentDueMs(b);
      case "dueLatest":
        return paid ? paymentDueMs(a) - paymentDueMs(b) : paymentDueMs(b) - paymentDueMs(a);
      case "amountDesc":
        return moneyToNumber(b.amount) - moneyToNumber(a.amount);
      case "amountAsc":
        return moneyToNumber(a.amount) - moneyToNumber(b.amount);
      default:
        return a.resident.localeCompare(b.resident, undefined, { sensitivity: "base" });
    }
  });
}

/** A resident's (or house's) charges stay adjacent, in the order the sort gave them (`flattenLedgerClusters`). */
function clusterPayments(rows: PaymentFixtureRow[], mode: PortalListGroupMode): PaymentFixtureRow[] {
  const keyOf = (row: PaymentFixtureRow) => (mode === "house" ? row.property : row.resident);
  const order: string[] = [];
  for (const row of rows) if (!order.includes(keyOf(row))) order.push(keyOf(row));
  return order.flatMap((key) => rows.filter((row) => keyOf(row) === key));
}

export function PaymentsPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const jordan = world.story.leaseStep === 3 ? (world.story.rentPaid ? "paid" : "pending") : null;
  const [bucket, setBucket] = useState<PaymentBucket>(jordan ?? "overdue");
  useFollow<PaymentBucket>(jordan, setBucket);
  usePreloadPopups();
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [residentFilters, setResidentFilters] = useState<string[]>([]);
  const [listSort, setListSort] = useState<PaymentListSort>("dueSoon");
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [showUpcoming, setShowUpcoming] = useState(true);
  // What the page does locally in this visit: a charge marked paid moves tabs, a deleted one is gone.
  const [movedToPaid, setMovedToPaid] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const selection = useRowSelection();
  const { show, node: toastNode } = useFixtureToast();

  const allRows = useMemo(
    () =>
      world.payments
        .filter((r) => !deleted.has(r.id))
        .map((r) => (movedToPaid.has(r.id) ? { ...r, bucket: "paid" as const, due: `Paid ${r.due.replace(/^Due /, "")}`, tone: "ok" as const } : r))
        // "Upcoming charges: Hide" drops the pending charges that are not due yet.
        .filter((r) => showUpcoming || !(r.bucket === "pending" && paymentDueMs(r) > DEMO_TODAY_MS)),
    [world, deleted, movedToPaid, showUpcoming],
  );
  const counts = useMemo(() => {
    const c: Record<PaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const r of allRows) c[r.bucket] += 1;
    return c;
  }, [allRows]);
  // The strip adds what each bucket holds: what is still owed, or what came in (`bucketStats`).
  const stats = useMemo(
    (): PortalStat[] =>
      PAYMENT_TABS.map(({ id, label }) => {
        const cents = sumMoneyLabelsCents(allRows.filter((r) => r.bucket === id).map((r) => r.amount));
        return { id, label, value: formatCentsAsUsd(cents), dataAttr: `payments-stat-${id}`, tone: id === "overdue" && cents > 0 ? ("danger" as const) : undefined };
      }),
    [allRows],
  );
  const rows = useMemo(() => {
    const filtered = allRows.filter(
      (r) =>
        r.bucket === bucket &&
        matchesSearch(search, r.resident, r.chargeTitle, r.property, r.due, r.amount) &&
        (propertyFilters.length === 0 || propertyFilters.includes(r.property)) &&
        (residentFilters.length === 0 || residentFilters.includes(r.resident)),
    );
    return clusterPayments(sortPayments(filtered, bucket, listSort), groupMode);
  }, [allRows, bucket, search, propertyFilters, residentFilters, listSort, groupMode]);

  const propertyOptions = useMemo(() => paymentPropertyOptions(world.payments), [world]);
  const residentOptions = useMemo(() => paymentResidentOptions(world.payments), [world]);
  const filterTouches =
    (propertyFilters.length > 0 ? 1 : 0) +
    (residentFilters.length > 0 ? 1 : 0) +
    (listSort !== "dueSoon" ? 1 : 0) +
    (groupMode !== DEFAULT_PORTAL_LIST_GROUP_MODE ? 1 : 0) +
    (showUpcoming ? 0 : 1);

  const openRow = openId ? allRows.find((r) => r.id === openId) ?? null : null;
  const editingRow = editingId ? allRows.find((r) => r.id === editingId) ?? null : null;
  const selectedRow = allRows.find((r) => r.id === selection.only);

  const act = (row: PaymentFixtureRow, id: string) => {
    if (id === "send-reminder") {
      show(`Reminder sent — ${row.resident} (sample)`);
      setOpenId(null);
    } else if (id === "mark-paid") {
      setMovedToPaid((s) => new Set(s).add(row.id));
      show(`${row.amount} paid — ${row.resident} (sample)`);
      setOpenId(null);
      setBucket("paid");
    } else if (id === "edit") {
      setEditingId(row.id);
    } else if (id === "delete") {
      setDeleted((s) => new Set(s).add(row.id));
      show("Payment removed (sample)");
      setOpenId(null);
    } else if (id === "refund") {
      show("Refund started (sample)");
    } else {
      show("Payment settings (sample)");
    }
    selection.clear();
  };

  const rowMenu = (row: PaymentFixtureRow) => (
    <>
      {row.bucket === "paid" ? (
        <DropdownMenuItem onSelect={() => act(row, "refund")}>Refund</DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onSelect={() => act(row, "mark-paid")}>Mark as paid</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(row, "send-reminder")}>Send reminder</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(row, "edit")}>Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(row, "delete")} className="text-danger">
            Delete
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  const frame = (children: ReactNode) => (
    <ProductWindow path={openRow ? `/portal/payments/incoming/${openRow.bucket}/${openRow.id}` : `/portal/payments/incoming/${bucket}`}>
      <PortalSidebarFixture active="payments" counts={{ payments: counts.overdue }} />
      <div className={DEMO_PAGE_CLASS}>{children}</div>
      {adding ? (
        <DemoAddChargePopup
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            show("Charge added (sample)");
          }}
        />
      ) : null}
      {editingRow ? (
        <DemoEditPaymentPopup
          row={editingRow}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            show("Payment updated (sample)");
          }}
          onMarkPaid={() => {
            setEditingId(null);
            act(editingRow, "mark-paid");
          }}
          onDelete={() => {
            setEditingId(null);
            act(editingRow, "delete");
          }}
        />
      ) : null}
      {toastNode}
    </ProductWindow>
  );

  if (openRow) {
    return frame(<DemoPaymentRecordView row={openRow} onBack={() => setOpenId(null)} onAction={(id) => act(openRow, id)} />);
  }

  return frame(
    <ManagerPortalPageShell title="Incoming payments" titleInlineFilter={null} hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-2"
        variant="command"
        stickyDestinations={false}
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            ariaLabel="Payment status"
            items={PAYMENT_TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts.overdue > 0 }))}
            activeId={bucket}
            onChange={(id) => {
              setBucket(id as PaymentBucket);
              selection.clear();
            }}
          />
        }
        search={{ value: search, onChange: setSearch, placeholder: "Search payments" }}
        actions={
          <>
            <DemoFilterSheet
              activeCount={filterTouches}
              compactPanel
              commandStripTrigger
              filterFieldCount={5}
              mobileFlushBody
              constrainDropdownToTitleBand={false}
              className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
              onReset={() => {
                setPropertyFilters([]);
                setResidentFilters([]);
                setListSort("dueSoon");
                setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
                setShowUpcoming(true);
              }}
              dataAttr="payments-filter-sheet-open"
            >
              <PaymentFilterSortFields
                propertyOptions={propertyOptions}
                propertyFilters={propertyFilters}
                onPropertyFiltersChange={setPropertyFilters}
                residentOptions={residentOptions}
                residentFilters={residentFilters}
                onResidentFiltersChange={setResidentFilters}
                showResidentFilter
                listSort={listSort}
                onListSortChange={setListSort}
                sortOptions={PAY_SORT_OPTIONS}
                defaultListSort="dueSoon"
                groupMode={groupMode}
                onGroupModeChange={setGroupMode}
                showUpcomingChargesField
                showUpcomingCharges={showUpcoming}
                onShowUpcomingChargesChange={setShowUpcoming}
              />
            </DemoFilterSheet>
            <PortalIconAction icon={Settings} label="Payment settings" data-attr="manager-payments-settings-gear" onClick={() => show("Payment settings (sample)")} />
          </>
        }
        primary={<PortalPrimaryIconAction label="Add charge" data-attr="payments-add-top" onClick={() => setAdding(true)} />}
        stats={<PortalStatStrip items={stats} dataAttr="payments-stat-strip" />}
      />
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        emptyCard={{
          title:
            rows.length === 0 && counts[bucket] > 0 && (search.trim() || filterTouches > 0)
              ? portalEmptyNoMatchTitle("payments", search)
              : portalEmptyCopy(`payments.${bucket}` as PortalEmptyCopyKey).title,
          section: "payments",
        }}
        bulkActions={selectedRow ? rowMenu(selectedRow) : undefined}
        onBulkClear={selection.clear}
      >
        {rows.map((row) => (
          <DemoTarget id="payment-row" key={row.id}>
            <PortalApplicantRecordRow
              name={row.resident}
              address={`${row.chargeTitle} · ${row.property}`}
              facts={<PortalRowFact icon={CalendarDays}>{row.due}</PortalRowFact>}
              amount={row.amount}
              amountTone={row.tone}
              checked={selection.isChecked(row.id)}
              onSelectedChange={(checked) => selection.set(row.id, checked)}
              onOpen={() => setOpenId(row.id)}
              dataAttr="payment-list-row"
            />
          </DemoTarget>
        ))}
      </PortalRecordListSurface>
    </ManagerPortalPageShell>,
  );
}

/* ───────────────────────────── Services ───────────────────────────── */

const SERVICE_STAGE_EMPTY = (stage: ServiceStage) => portalEmptyCopy(`services.${stage}` as PortalEmptyCopyKey).title;

/** "Assigned to" (the Services Filter's third field): Anyone · Unassigned · Assigned · each hired name. */
function ServicesAssigneeField({ value, onChange, options }: { value: string; onChange: (next: string) => void; options: { id: string; label: string }[] }) {
  const closeFieldMenu = useFilterAccordionClose();
  const list = options.map((o) => ({ value: o.id, label: o.label }));
  return (
    <FilterCollapsibleSection
      sectionId="assignee"
      label="Assigned to"
      summary={filterSingleSelectSummary(value, list, "Anyone")}
      empty={!value}
      menuOptionCount={list.length}
      dataAttr="services-filter-assignee-trigger"
    >
      <FilterSingleSelectList options={list} value={value} onChange={onChange} onPick={closeFieldMenu} dataAttr="services-filter-assignee" />
    </FilterCollapsibleSection>
  );
}

/** Where the service stands by tab, as the plain glyph fact `managerServiceRowFacts` draws. */
function serviceStageFact(row: MoneyServiceRow): { icon: LucideIcon; text: string } {
  if (row.stage === "assigned") return { icon: UserCheck, text: row.vendor ? `Assigned to ${row.vendor}` : "Assigned" };
  if (row.stage === "scheduled") return { icon: CalendarDays, text: row.visit ? `${row.vendor ? `${row.vendor} · ` : ""}${row.visit}` : row.detail };
  if (row.stage === "completed") return { icon: row.state === "declined" || /^(Cancelled|Declined)/.test(row.detail) ? Ban : CircleCheck, text: row.detail };
  return { icon: Clock, text: row.detail };
}

export function ServicesPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const allServices = useMemo(() => [...world.services, ...ASSIGNED_SERVICE_ROWS].map(moneyServiceRow), [world]);
  const jordan = world.story.service === "none" ? null : moneyServiceRow(world.services[0]!).stage;
  const [stage, setStage] = useState<ServiceStage>(jordan ?? "scheduled");
  useFollow<ServiceStage>(jordan, setStage);
  usePreloadPopups();
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [residentFilters, setResidentFilters] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  // Cancelled / declined services keep their row: they move to Completed with the word as their detail.
  const [closedOut, setClosedOut] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { show, node: toastNode } = useFixtureToast();

  const services = useMemo(
    () =>
      allServices
        .filter((r) => !deleted.has(r.id))
        .map((r) =>
          closedOut[r.id]
            ? { ...r, stage: "completed" as const, detail: closedOut[r.id]! }
            : completedIds.has(r.id)
              ? { ...r, stage: "completed" as const, detail: "Completed Sep 25" }
              : r,
        ),
    [allServices, deleted, completedIds, closedOut],
  );
  const counts = useMemo(() => {
    const c: Record<ServiceStage, number> = { open: 0, assigned: 0, scheduled: 0, completed: 0 };
    for (const r of services) c[r.stage] += 1;
    return c;
  }, [services]);
  const propertyOptions = useMemo(() => [...new Set(allServices.map((r) => r.property))].sort().map((label) => ({ id: label, label })), [allServices]);
  const residentOptions = useMemo(() => [...new Set(allServices.map((r) => r.resident))].sort().map((label) => ({ id: label, label })), [allServices]);
  const assigneeOptions = useMemo(() => serviceAssigneeOptions(allServices), [allServices]);
  const filterCount = portalFilterActiveCount([propertyFilters, residentFilters, assigneeFilter ? [assigneeFilter] : []]);
  const rows = services.filter(
    (r) =>
      r.stage === stage &&
      matchesSearch(search, r.title, r.resident, r.property, r.room) &&
      (propertyFilters.length === 0 || propertyFilters.includes(r.property)) &&
      (residentFilters.length === 0 || residentFilters.includes(r.resident)) &&
      serviceMatchesAssignee(r, assigneeFilter),
  );
  const openRow = openId ? services.find((r) => r.id === openId) ?? null : null;

  const act = (row: MoneyServiceRow, id: string) => {
    if (id === "dispatch") show("Dispatched — Pacific Plumbing (sample)");
    else if (id === "approve-change-order") show("Change order approved — $90 (sample)");
    else if (id === "approve") show("Request approved (sample)");
    else if (id === "complete") {
      setCompletedIds((s) => new Set(s).add(row.id));
      show("Service completed (sample)");
    } else if (id === "cancel" || id === "decline") {
      // Cancel service keeps the history: the row moves to Completed as Cancelled (a declined request as Declined).
      setClosedOut((s) => ({ ...s, [row.id]: id === "cancel" ? "Cancelled Sep 25" : "Declined Sep 25" }));
      show(id === "cancel" ? "Service cancelled (sample)" : "Request declined (sample)");
    } else if (id === "delete") {
      setDeleted((s) => new Set(s).add(row.id));
      show("Service removed (sample)");
    } else if (id === "message") show(`Message ${row.resident} (sample)`);
    else show(`${id.replace(/-/g, " ")} (sample)`);
    setOpenId(null);
  };

  const sidebar = <PortalSidebarFixture active="services" counts={{ services: counts.open }} />;
  const addPopup = adding ? (
    <DemoAddServicePopup
      onClose={() => setAdding(false)}
      onAdded={() => {
        setAdding(false);
        setStage("open");
        show("Service added (sample)");
      }}
    />
  ) : null;

  if (openRow) {
    return (
      <ProductWindow path={`/portal/services/${openRow.kind === "add-on" ? "requests" : "work-orders"}/${openRow.stage}/${openRow.id}`}>
        {sidebar}
        <div className={DEMO_PAGE_CLASS}>
          <DemoServiceRecordView row={openRow} onBack={() => setOpenId(null)} onAction={(id) => act(openRow, id)} />
        </div>
        {toastNode}
      </ProductWindow>
    );
  }

  return (
    <FixtureListScreen
      path="/portal/services"
      sidebar={sidebar}
      overlay={
        <>
          {addPopup}
          {toastNode}
        </>
      }
      title="Services"
      tabs={SERVICE_STAGE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={stage}
      onTab={(id) => setStage(id as ServiceStage)}
      tabAriaLabel="Service status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search services"
      actions={
        <DemoFilterSheet
          activeCount={filterCount}
          compactPanel
          commandStripTrigger
          filterFieldCount={3}
          constrainDropdownToTitleBand={false}
          mobileFlushBody
          className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
          onReset={() => {
            setPropertyFilters([]);
            setResidentFilters([]);
            setAssigneeFilter("");
          }}
          dataAttr="services-filter-sheet-open"
        >
          <FilterFieldsAccordion>
            <ApplicationFilterSortFields
              propertyOptions={propertyOptions}
              propertyFilters={propertyFilters}
              onPropertyFiltersChange={setPropertyFilters}
              dataAttr="services-filter-property"
              selectionMode="single"
            />
            <PortalListResidentField
              residentOptions={residentOptions}
              residentFilters={residentFilters}
              onResidentFiltersChange={setResidentFilters}
              dataAttr="services-filter-resident"
            />
          </FilterFieldsAccordion>
          <ServicesAssigneeField value={assigneeFilter} onChange={setAssigneeFilter} options={assigneeOptions} />
        </DemoFilterSheet>
      }
      primary={{ label: portalListAddPrimaryLabel("service"), onClick: () => setAdding(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        rows.length === 0 && counts[stage] > 0 && (search.trim() || filterCount > 0) ? portalEmptyNoMatchTitle("services") : SERVICE_STAGE_EMPTY(stage)
      }
      emptySection="services"
    >
      {rows.map((row) => (
        <DemoTarget id="service-row" key={row.id}>
          <ManagerServiceCardRow
            row={{ title: row.title, residentName: row.resident, propertyLabel: row.property, unitLabel: row.room ?? "", residentEmail: "", scheduledIso: "", createdIso: "" }}
            figure={row.price}
            facts={{ stage: serviceStageFact(row) }}
            menu={
              <ServiceListRowMenu
                title={row.title}
                items={serviceMenuItems(row)}
                onAction={(id) => (id === "request-bids" || id === "assign" || id === "schedule" || id === "approve-bid" ? show(`${id.replace(/-/g, " ")} (sample)`) : act(row, id))}
              />
            }
            onOpen={() => setOpenId(row.id)}
            dataAttr={row.kind === "add-on" ? "service-request-list-row" : "work-order-list-row"}
          />
        </DemoTarget>
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

const COMM_ROLE_OPTIONS: { value: CommunicationFilterRole; label: string }[] = [
  { value: "resident", label: "Residents & applicants" },
  { value: "management", label: roleLabel("management") },
  { value: "admin", label: roleLabel("admin") },
  { value: "vendor", label: roleLabel("vendor") },
];

type SentMessage = { id: string; author: string; body: string; at: string; direction: "outbound" };

/** The row ⋯ (`CommunicationRowActions`): Archive (+ Edit) on an active row, Restore · Delete on an archived one. */
function CommRowActions({ name, archived, onArchive, onRestore, onDelete, onEdit }: { name: string; archived: boolean; onArchive: () => void; onRestore: () => void; onDelete: () => void; onEdit: () => void }) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: `${archived}:${name}`,
        clear: () => {},
        actions: archived ? (
          <>
            <Button variant="outline" data-record-action-id="restore" onClick={onRestore}>
              Restore
            </Button>
            <Button variant="danger" data-record-action-id="delete" onClick={onDelete}>
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onArchive}>
              Archive
            </Button>
            <Button variant="outline" data-record-action-id="edit" onClick={onEdit}>
              Edit
            </Button>
          </>
        ),
      }}
    >
      <RecordActionMenu label={name} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

export function CommunicationPanel() {
  usePreloadPopups();
  const [segment, setSegment] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<CommunicationThreadFilters>({ ...EMPTY_COMMUNICATION_THREAD_FILTERS, status: "active" });
  const [listSort, setListSort] = useState<CommunicationListSort>("recent");
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set(COMM_CONVERSATIONS.filter((c) => c.segment === "archived").map((c) => c.id)));
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set(COMM_CONVERSATIONS.filter((c) => c.unread).map((c) => c.id)));
  const [selectedId, setSelectedId] = useState(COMM_CONVERSATIONS.find((c) => c.segment === "active")?.id ?? COMM_CONVERSATIONS[0]!.id);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<Record<string, SentMessage[]>>({});
  const [composing, setComposing] = useState(false);
  const { show, node: toastNode } = useFixtureToast();
  // The list and thread sit side by side from the desktop breakpoint; below it the real inbox shows the list
  // until a row is opened, then the thread with a back arrow.
  const [wide, setWide] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const all = COMM_CONVERSATIONS.filter((c) => !deletedIds.has(c.id));
  const segmentOf = (c: CommConversationFixture): "active" | "archived" => (archivedIds.has(c.id) ? "archived" : "active");
  const counts = {
    active: all.filter((c) => segmentOf(c) === "active").length,
    archived: all.filter((c) => segmentOf(c) === "archived").length,
  };
  const houseOptions = useMemo(
    () => [...new Set(Object.values(COMM_CONTACTS).map((c) => c.house).filter((h): h is string => Boolean(h)))].sort().map((value) => ({ value, label: value })),
    [],
  );
  const visible = all
    .filter((c) => {
      const contact = COMM_CONTACTS[c.id];
      return (
        segmentOf(c) === segment &&
        matchesSearch(query, c.name, c.preview, contact?.house, contact?.email) &&
        (filters.propertyIds.length === 0 || (contact?.house !== undefined && filters.propertyIds.includes(contact.house))) &&
        (filters.roles.length === 0 || (contact !== undefined && filters.roles.includes(contact.filterRole))) &&
        (!filters.recordKinds?.length || (contact !== undefined && filters.recordKinds.includes(contact.about))) &&
        (filters.status !== "unread" || unreadIds.has(c.id)) &&
        (filters.status !== "read" || !unreadIds.has(c.id))
      );
    })
    .sort((a, b) => (listSort === "resident" ? a.name.localeCompare(b.name) : 0));
  const selected = all.find((c) => c.id === selectedId) ?? visible[0];
  const contact = selected ? COMM_CONTACTS[selected.id] : undefined;
  const messages = selected ? [...selected.messages, ...(sent[selected.id] ?? [])] : [];
  const filterTouches = filters.propertyIds.length + filters.roles.length + (filters.recordKinds?.length ?? 0) + (filters.status !== "active" ? 1 : 0) + (listSort !== "recent" ? 1 : 0);

  function send() {
    if (!draft.trim() || !selected) return;
    setSent((m) => ({
      ...m,
      [selected.id]: [...(m[selected.id] ?? []), { id: `local-${(m[selected.id]?.length ?? 0) + 1}`, author: "You", body: draft, at: "Just now", direction: "outbound" }],
    }));
    setDraft("");
    show("Sent (sample)");
  }

  const archive = (id: string) => {
    setArchivedIds((s) => new Set(s).add(id));
    show("Archived (sample)");
  };
  const restore = (id: string) => {
    setArchivedIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    show("Restored (sample)");
  };
  const remove = (id: string) => {
    setDeletedIds((s) => new Set(s).add(id));
    show("Conversation deleted (sample)");
  };

  const iconBtn = (label: string, Icon: LucideIcon, onClick: () => void, danger = false, dataAttr?: string) => (
    <button key={label} type="button" className={danger ? INBOX_THREAD_ICON_BTN_DANGER : INBOX_THREAD_ICON_BTN} aria-label={label} title={label} data-attr={dataAttr} onClick={onClick}>
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
  const threadActions =
    selected && segmentOf(selected) === "archived" ? (
      <>
        {iconBtn("Restore conversation", ArchiveRestore, () => restore(selected.id), false, "inbox-thread-restore")}
        {iconBtn("Delete conversation", Trash2, () => remove(selected.id), true, "inbox-thread-delete")}
      </>
    ) : selected ? (
      <>
        {contact?.phone ? iconBtn("Call", Phone, () => show(`Call ${contact.phone} (sample)`), false, "inbox-thread-call") : null}
        {contact?.resident ? iconBtn("Open resident", UserRound, () => show("Open resident (sample)"), false, "inbox-thread-open-resident") : null}
        {iconBtn("Contact information", Info, () => show("Contact information (sample)"), false, "inbox-thread-contact-edit")}
        {iconBtn("Mark unread", MailOpen, () => setUnreadIds((s) => new Set(s).add(selected.id)), false, "inbox-thread-mark-unread")}
        {iconBtn("Archive conversation", Archive, () => archive(selected.id), false, "inbox-thread-archive")}
      </>
    ) : null;

  const listControls = (
    <div className="flex shrink-0 items-center gap-1 [&_button]:shrink-0" data-attr="communication-list-actions">
      {segment === "archived" && counts.archived > 0 ? (
        <PortalIconAction
          icon={Trash2}
          label="Delete all archived"
          tone="danger"
          data-attr="unified-inbox-delete-all-archived"
          onClick={() => {
            setDeletedIds((s) => new Set([...s, ...all.filter((c) => segmentOf(c) === "archived").map((c) => c.id)]));
            show("Archived conversations deleted (sample)");
          }}
        />
      ) : null}
      <DemoFilterSheet
        activeCount={filterTouches}
        compactPanel
        filterFieldCount={4}
        constrainDropdownToTitleBand={false}
        commandStripTrigger
        mobileFlushBody
        onReset={() => {
          setFilters({ ...EMPTY_COMMUNICATION_THREAD_FILTERS, status: "active" });
          setListSort("recent");
        }}
        dataAttr="communication-filter-sheet-open"
      >
        <CommunicationFilterSortFields
          propertyOptions={houseOptions}
          roleOptions={COMM_ROLE_OPTIONS}
          filters={filters}
          onFiltersChange={setFilters}
          listSort={listSort}
          onListSortChange={setListSort}
          hideArchived
        />
      </DemoFilterSheet>
      <PortalIconAction icon={Plug} label="Integrations" data-attr="communication-integrations" onClick={() => show("Integrations (sample)")} />
      <PortalPrimaryIconAction icon={MessageSquarePlus} label="New message" data-attr="communication-new-message" onClick={() => setComposing(true)} />
    </div>
  );

  return (
    <ProductWindow path={`/portal/communication/${segment}`} nativeHeight={780}>
      <PortalSidebarFixture active="communication" counts={{ communication: counts.active }} />
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Communication" viewportFillBody hideTitleOnMobileNav>
          <InboxTwoPane
            panes="flat"
            threadOpen={wide || opened}
            fillParent
            list={
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0" data-attr="communication-list-header-card">
                  <InboxListHeader
                    tabs={
                      <InboxListSegmentTabs
                        commBase="/portal/communication"
                        value={segment}
                        onChange={(next) => setSegment(next)}
                        counts={counts}
                        interceptNavigation
                        layout="inline"
                      />
                    }
                    search={{ value: query, onChange: setQuery, placeholder: "Search communication", ariaLabel: "Search contacts or messages", dataAttr: "unified-inbox-search" }}
                    count={visible.length}
                    trailing={listControls}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto" data-communication-inbox-list>
                  {visible.length === 0 ? (
                    <p className="p-4 text-sm text-muted">
                      {query.trim() ? portalEmptyNoMatchTitle("messages", query) : portalEmptyCopy(`communication.${segment}` as PortalEmptyCopyKey).title}
                    </p>
                  ) : (
                    visible.map((c) => (
                      <InboxConversationRow
                        key={c.id}
                        listVariant="manager"
                        appearance="flat"
                        name={c.name}
                        preview={c.preview}
                        previewPrefix={c.messages[c.messages.length - 1]?.direction === "outbound" ? "You: " : undefined}
                        time={c.time}
                        unread={unreadIds.has(c.id)}
                        selected={c.id === selected?.id}
                        trailing={
                          <CommRowActions
                            name={c.name}
                            archived={segment === "archived"}
                            onArchive={() => archive(c.id)}
                            onRestore={() => restore(c.id)}
                            onDelete={() => remove(c.id)}
                            onEdit={() => show("Contact information (sample)")}
                          />
                        }
                        onOpen={() => {
                          setSelectedId(c.id);
                          setUnreadIds((s) => {
                            const next = new Set(s);
                            next.delete(c.id);
                            return next;
                          });
                          setOpened(true);
                        }}
                      />
                    ))
                  )}
                </div>
              </div>
            }
            thread={
              selected ? (
                <InboxThreadView
                  title={selected.name}
                  subtitle={commSubtitle(selected.id) || selected.subtitle}
                  avatarName={selected.name}
                  messages={messages}
                  onBack={() => setOpened(false)}
                  headerActions={threadActions}
                  composer={segment === "archived" ? undefined : <InboxComposer value={draft} onChange={setDraft} onSubmit={send} placeholder="Write a reply…" dataAttr="comm-panel-composer" />}
                />
              ) : null
            }
          />
        </ManagerPortalPageShell>
      </div>
      {composing ? (
        <DemoNewMessagePopup
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            show("Message sent (sample)");
          }}
        />
      ) : null}
      {toastNode}
    </ProductWindow>
  );
}
