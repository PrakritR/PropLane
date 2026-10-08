"use client";

/**
 * The resident portal's tabs for the home page demo — My home, Applications,
 * Lease, Payments, Services, Forms, Communication — drawn for one resident
 * (Jordan, Willow Court · Room 3) from the shared "Seattle Homes"
 * fixtures and the story's progress (`world.ts`). Each mirrors its real screen's tab names, command bar and row
 * anatomy (`resident-move-in-panel.tsx`, `resident-applications-panel.tsx`,
 * `resident-lease-list.tsx`, `resident-payments-panel.tsx`,
 * `resident-services-panel.tsx`, `move-in-forms/resident-move-in-forms.tsx`,
 * `resident-communication.tsx`). The real panels fetch on mount, so the rows
 * and cards are composed from the same presentational pieces instead.
 *
 * What a row or the round + opens is the real portal's: a record page (`demo-popups-resident.tsx`, loaded on demand
 * through `demo-popups-lazy-resident.tsx`) or the real pop-up with its fields. Nothing here fetches or saves; a
 * commit closes the pop-up and toasts "(sample)".
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, CalendarDays, CheckCircle2, Clock, FileText, Home, Lock, Mail, MailOpen, Phone, Trash2, Wrench } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import {
  INBOX_LIST_SCROLL,
  INBOX_THREAD_ICON_BTN,
  INBOX_THREAD_ICON_BTN_DANGER,
  InboxComposer,
  InboxConversationRow,
  InboxListHeader,
  InboxListSegmentTabs,
  InboxThreadView,
  InboxTwoPane,
} from "@/components/portal/portal-inbox-ui";
import { CommunicationStatusFilterDraft, type CommunicationStatus } from "@/components/portal/communication-status-filter";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { RECORD_KIND_FILTER_OPTIONS } from "@/lib/communication-thread-filters";
import { RESIDENT_INSPECTION_TAB_LABELS, RESIDENT_INSPECTION_TYPE_LABELS } from "@/lib/resident-inspections-tabs";
import { RESIDENT_MOVE_IN_TAB_LABELS, RESIDENT_MOVE_IN_TABS } from "@/lib/portal-detail-routes";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import {
  RESIDENT_HOME,
  RESIDENT_NAME,
  RESIDENT_SELF,
  type CommConversationFixture,
  type ResidentFormFixture,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  residentForms,
  residentHomeProgress,
  residentLeases,
  worldFor,
  type DemoStory,
} from "@/components/marketing/site/product-mock/world";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { DEMO_PAGE_CLASS, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import {
  ResidentAddServiceModal,
  ResidentApplicationRecord,
  ResidentApplyModal,
  ResidentComposeModal,
  ResidentConfirmModal,
  ResidentFormFlow,
  ResidentInspectionRecord,
  ResidentLeaseRecord,
  ResidentMoveInDetailsBody,
  ResidentPayModal,
  ResidentPaymentRecord,
  ResidentPlacementBody,
  ResidentRoommatesBody,
  ResidentServiceRecord,
  ResidentWithdrawModal,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-resident";

const CARD = "rounded-xl border border-border bg-card";

/** The window and page frame a record page draws in, in place of the list (the real portal navigates to it). */
export function ResidentRecordFrame({ path, toast, children }: { path: string; toast?: ReactNode; children: ReactNode }) {
  return (
    <ProductWindow path={path}>
      <div className={DEMO_PAGE_CLASS}>{children}</div>
      {toast}
    </ProductWindow>
  );
}

/* ───────────────────────────── My home ───────────────────────────── */

const HOME_TABS = RESIDENT_MOVE_IN_TABS.map((id) => ({
  id: id === "info" ? "details" : id === "housemates" ? "roommates" : id,
  label: RESIDENT_MOVE_IN_TAB_LABELS[id],
}));

export function ResidentHomePanel({ story }: { story?: DemoStory } = {}) {
  const progress = residentHomeProgress(worldFor(story).story);
  const [tab, setTab] = useState("placement");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [inspecting, setInspecting] = useState(false);
  const { show, node: toastNode } = useFixtureToast();
  const inspections = progress.inspections;
  const rows = inspections.filter((row) => matchesSearch(search, row.title));

  if (inspecting) {
    return (
      <ResidentRecordFrame path="/resident/move-in/inspections/new" toast={toastNode}>
        <ResidentInspectionRecord onBack={() => setInspecting(false)} onToast={show} />
      </ResidentRecordFrame>
    );
  }

  return (
    <ProductWindow path="/resident/move-in">
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="My home" hideTitleOnMobileNav compactFilterRow>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinationRow={
              <LocalDestinationNav appearance="command" ariaLabel="My home" items={HOME_TABS} activeId={tab} onChange={setTab} />
            }
            search={progress.unlocked && tab === "inspections" ? { value: search, onChange: setSearch, placeholder: "Search inspections" } : undefined}
            actions={
              progress.unlocked && tab === "inspections" ? (
                <DemoFilterSheet
                  activeCount={portalFilterActiveCount([type !== "all" ? type : "", status !== "all" ? status : ""])}
                  compactPanel
                  commandStripTrigger
                  filterFieldCount={2}
                  onReset={() => {
                    setType("all");
                    setStatus("all");
                  }}
                  dataAttr="resident-inspections-type-filter-open"
                >
                  <FieldSingleSelect
                    label="Status"
                    variant="cell"
                    value={status}
                    onChange={setStatus}
                    options={[{ value: "all", label: "All statuses" }, ...Object.entries(RESIDENT_INSPECTION_TAB_LABELS).map(([value, label]) => ({ value, label }))]}
                    dataAttr="resident-inspections-status-select"
                  />
                  <FieldSingleSelect
                    label="Type"
                    variant="cell"
                    value={type}
                    onChange={setType}
                    options={[
                      { value: "all", label: "All types" },
                      { value: "move-in", label: RESIDENT_INSPECTION_TYPE_LABELS["move-in"] },
                      { value: "move-out", label: RESIDENT_INSPECTION_TYPE_LABELS["move-out"] },
                    ]}
                    dataAttr="resident-inspections-type-select"
                  />
                </DemoFilterSheet>
              ) : undefined
            }
            primary={
              progress.unlocked && tab === "inspections" ? (
                <PortalPrimaryIconAction label="Add move-in inspection" onClick={() => setInspecting(true)} data-attr="inspection-add" />
              ) : undefined
            }
          />
          {!progress.unlocked ? (
            <div className={`${CARD} flex items-center gap-3 px-4 py-6`}>
              <Lock className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 text-[13.5px] font-medium text-foreground">My home opens once your lease is signed.</span>
            </div>
          ) : null}
          {progress.unlocked && tab === "placement" ? <ResidentPlacementBody checklist={progress.checklist} /> : null}
          {progress.unlocked && tab === "details" ? <ResidentMoveInDetailsBody /> : null}
          {progress.unlocked && tab === "roommates" ? <ResidentRoommatesBody /> : null}
          {progress.unlocked && tab === "inspections" ? (
            <PortalRecordListSurface
              isEmpty={rows.length === 0}
              emptyCard={
                search.trim() && inspections.length > 0
                  ? { title: portalEmptyNoMatchTitle("inspections", search), section: "inspections", tone: "muted" }
                  : { title: "No inspections yet", section: "inspections" }
              }
            >
              {null}
            </PortalRecordListSurface>
          ) : null}
        </ManagerPortalPageShell>
      </div>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Applications ───────────────────────────── */

const APPLICATION_TABS = [
  { id: "sent", label: "Sent" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" },
];
const APPLICATION_TAB_OF: Record<string, string> = { incomplete: "sent", pending: "sent", approved: "approved", rejected: "denied" };

export function ResidentApplicationsPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const mine = useMemo(() => world.applications.filter((a) => a.name === RESIDENT_NAME), [world]);
  const [withdrawnIds, setWithdrawnIds] = useState<string[]>([]);
  const live = useMemo(() => mine.filter((a) => !withdrawnIds.includes(a.id)), [mine, withdrawnIds]);
  const counts = useMemo(() => countBy(live, (a) => APPLICATION_TAB_OF[a.bucket]!, ["sent", "approved", "denied"]), [live]);
  const jordan = mine[0] ? APPLICATION_TAB_OF[mine[0].bucket]! : null;
  const [tab, setTab] = useState(jordan ?? "sent");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [applying, setApplying] = useState(false);
  const [record, setRecord] = useState<(typeof mine)[number] | null>(null);
  const [withdrawing, setWithdrawing] = useState<(typeof mine)[number] | null>(null);
  const rows = live.filter((a) => APPLICATION_TAB_OF[a.bucket] === tab && matchesSearch(search, a.property, a.unit));
  const selected = live.find((a) => a.id === selection.only);
  const canWithdraw = (a: (typeof mine)[number]) => a.bucket === "pending" || a.bucket === "incomplete";

  const withdrawModal = withdrawing ? (
    <ResidentWithdrawModal
      property={withdrawing.property}
      onClose={() => setWithdrawing(null)}
      onWithdrawn={() => {
        setWithdrawnIds((ids) => [...ids, withdrawing.id]);
        setWithdrawing(null);
        setRecord(null);
        selection.clear();
        show("Application withdrawn (sample)");
      }}
    />
  ) : null;

  if (record) {
    return (
      <ResidentRecordFrame path={`/resident/applications/${record.id}`} toast={toastNode}>
        <ResidentApplicationRecord application={record} onBack={() => setRecord(null)} onToast={show} onWithdrawn={() => { setWithdrawnIds((ids) => [...ids, record.id]); setRecord(null); show("Application withdrawn (sample)"); }} />
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/applications"
      title="Applications"
      tabs={APPLICATION_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Application status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search applications"
      primary={{ label: portalListAddPrimaryLabel("application"), onClick: () => setApplying(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "sent" ? "Nothing sent" : tab === "approved" ? "Nothing approved" : "Nothing denied"}
      emptySection="applications"
      menu={
        selected ? (
          <>
            <DropdownMenuItem data-attr="resident-applications-open-selected" onSelect={() => setRecord(selected)}>
              {selected.bucket === "incomplete" ? "Continue" : "Open"}
            </DropdownMenuItem>
            {canWithdraw(selected) ? (
              <DropdownMenuItem data-attr="resident-application-withdraw" onSelect={() => setWithdrawing(selected)}>
                Withdraw
              </DropdownMenuItem>
            ) : null}
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {applying ? (
            <ResidentApplyModal
              onClose={() => setApplying(false)}
              onBrowse={() => {
                setApplying(false);
                show("Browse homes (sample)");
              }}
              onStart={() => {
                setApplying(false);
                show("Application started (sample)");
              }}
            />
          ) : null}
          {withdrawModal}
          {toastNode}
        </>
      }
    >
      {rows.map((a) => (
        <PortalApplicantRecordRow
          key={a.id}
          name={a.property}
          tileIcon={Home}
          address={`${a.unit} · Long-term`}
          facts={<PortalRowFact icon={CalendarDays}>{a.submitted}</PortalRowFact>}
          omitActionView
          checked={selection.isChecked(a.id)}
          onSelectedChange={(checked) => selection.set(a.id, checked)}
          onOpen={() => setRecord(a)}
          dataAttr="resident-application-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Lease ───────────────────────────── */

const LEASE_TABS = [
  { id: "pending", label: "Pending" },
  { id: "signed", label: "Signed" },
];

export function ResidentLeasePanel({ story }: { story?: DemoStory } = {}) {
  const leases = residentLeases(worldFor(story).story);
  const jordan = leases[0]?.bucket ?? null;
  const [tab, setTab] = useState<string>(jordan ?? "pending");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [record, setRecord] = useState<(typeof leases)[number] | null>(null);
  const counts = countBy(leases, (l) => l.bucket, ["pending", "signed"]);
  const rows = leases.filter((l) => l.bucket === tab && matchesSearch(search, "Lease agreement", RESIDENT_HOME.property));
  const selected = leases.find((l) => l.id === selection.only);

  if (record) {
    return (
      <ResidentRecordFrame path={`/resident/lease/${record.bucket}/${record.id}`} toast={toastNode}>
        <ResidentLeaseRecord lease={record} onBack={() => setRecord(null)} onToast={show} />
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/lease/signed"
      title="Lease"
      tabs={LEASE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Lease status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search leases"
      isEmpty={rows.length === 0}
      emptyTitle="No pending leases yet"
      emptySection="lease"
      menu={
        selected ? (
          <>
            <DropdownMenuItem onSelect={() => setRecord(selected)}>Open</DropdownMenuItem>
            {selected.bucket === "signed" ? <DropdownMenuItem onSelect={() => show("Download (sample)")}>Download</DropdownMenuItem> : null}
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={toastNode}
    >
      {rows.map((l) => (
        <PortalApplicantRecordRow
          key={l.id}
          name="Lease agreement"
          tileIcon={FileText}
          address={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room} · ${l.label}`}
          omitActionView
          checked={selection.isChecked(l.id)}
          onSelectedChange={(checked) => selection.set(l.id, checked)}
          onOpen={() => setRecord(l)}
          dataAttr="resident-lease-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

const PAYMENT_TABS = [
  { id: "pending", label: "Upcoming" },
  { id: "overdue", label: "Due" },
  { id: "paid", label: "Paid" },
];
const AUTOPAY_RUN_DAYS = [
  { value: "0", label: "On the due date" },
  { value: "1", label: "1 day before" },
  { value: "2", label: "2 days before" },
  { value: "3", label: "3 days before" },
];

/** `ResidentAutopayCard`: Autopay On/Off, Pays with, and Runs · Next payment once it is on. */
function AutopayCard({ onManage }: { onManage: () => void }) {
  const [on, setOn] = useState(false);
  const [runs, setRuns] = useState("0");
  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-3.5" data-attr="resident-autopay-card">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-foreground">Autopay</h3>
        <FieldSingleSelect
          label="Autopay"
          hideLabel
          wrapperClassName="w-28 shrink-0"
          value={on ? "on" : "off"}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(next) => setOn(next === "on")}
          dataAttr="resident-autopay-toggle"
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-sm text-muted">Pays with</span>
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground" data-attr="resident-autopay-method-label">
          Checking ending 6789
        </span>
        <Button type="button" variant="outline" onClick={onManage} data-attr="resident-autopay-add-method">
          Change
        </Button>
      </div>
      {on ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-sm text-muted">Runs</span>
            <FieldSingleSelect label="Runs" hideLabel value={runs} options={AUTOPAY_RUN_DAYS} onChange={setRuns} dataAttr="resident-autopay-run-days" />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-sm text-muted">Next payment</span>
            <span className="text-sm font-bold text-foreground" data-attr="resident-autopay-next-charge">
              Rent · {RESIDENT_HOME.rent}.00 on Nov 1
            </span>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The optional "Report my rent to credit bureaus" card (Upcoming only). */
function RentReportingCard() {
  const [on, setOn] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3.5" data-attr="resident-rent-reporting-card">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-bold text-foreground">Report my rent to credit bureaus</span>
        <FieldSingleSelect
          label="Report my rent to credit bureaus"
          hideLabel
          variant="cell"
          wrapperClassName="w-28"
          value={on ? "on" : "off"}
          onChange={(next) => setOn(next === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          dataAttr="resident-rent-reporting-toggle"
        />
      </div>
      {on ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted">Reported as</span>
            <span className="text-sm font-medium text-foreground">Jordan Rivera</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted">Last report</span>
            <span className="text-sm font-medium text-foreground">Not sent yet</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted">Bureaus</span>
            <span className="text-sm font-medium text-foreground">Equifax, TransUnion</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ResidentPaymentsPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const mine = useMemo(() => world.payments.filter((p) => p.resident === RESIDENT_NAME), [world]);
  const counts = useMemo(() => countBy(mine, (p) => p.bucket, ["pending", "overdue", "paid"]), [mine]);
  const jordan = mine[0]?.bucket ?? null;
  const [tab, setTab] = useState<string>(jordan ?? "pending");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [record, setRecord] = useState<(typeof mine)[number] | null>(null);
  const [paying, setPaying] = useState<Array<(typeof mine)[number]> | null>(null);
  // At most one charge ever: the real page hides the Upcoming / Due / Paid tabs (`shouldSimplifyResidentPaymentsHeader`).
  const simplified = mine.length <= 1;
  const rows = mine.filter((p) => (simplified || p.bucket === tab) && matchesSearch(search, p.chargeTitle, p.property));
  const bucket = simplified ? (mine[0]?.bucket ?? "pending") : tab;
  const unpaid = rows.filter((p) => p.bucket !== "paid");
  const selected = mine.find((p) => p.id === selection.only);
  const showPayActions = unpaid.length > 0 && (bucket === "pending" || bucket === "overdue");

  const payModal = paying ? (
    <ResidentPayModal
      charges={paying.map((p) => ({ title: p.chargeTitle, amount: p.amount }))}
      onClose={() => setPaying(null)}
      onContinue={(method) => {
        setPaying(null);
        show(`Continue with ${method} (sample)`);
      }}
    />
  ) : null;

  if (record) {
    return (
      <ResidentRecordFrame path={`/resident/payments/${record.bucket}/${record.id}`} toast={toastNode}>
        <ResidentPaymentRecord payment={record} onBack={() => setRecord(null)} onToast={show} onPay={() => setPaying([record])} />
        {payModal}
      </ResidentRecordFrame>
    );
  }

  return (
    <ResidentListScreen
      path="/resident/payments"
      title="Payments"
      tabs={simplified ? [] : PAYMENT_TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts[t.id]! > 0 }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Payment status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search payments"
      belowBar={
        <>
          <div className="mb-3 space-y-3">
            <AutopayCard onManage={() => show("Payment methods open in Settings (sample)")} />
            {bucket === "pending" ? <RentReportingCard /> : null}
          </div>
          {showPayActions && selection.only === null ? (
            <div className="mb-3 flex justify-end">
              <Button type="button" variant="primary" data-attr="resident-payments-pay-all" onClick={() => setPaying(unpaid)}>
                Pay all
              </Button>
            </div>
          ) : null}
        </>
      }
      isEmpty={rows.length === 0}
      emptyTitle={bucket === "overdue" ? "No overdue charges." : bucket === "pending" ? "No upcoming charges." : "No payments in this tab yet."}
      emptySection="payments"
      menu={
        selected && selected.bucket !== "paid" ? (
          <DropdownMenuItem data-attr="resident-payments-pay-selected" onSelect={() => setPaying([selected])}>
            Pay
          </DropdownMenuItem>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {payModal}
          {toastNode}
        </>
      }
    >
      {rows.map((p) => (
        <PortalApplicantRecordRow
          key={p.id}
          name={p.chargeTitle}
          tileIcon={FileText}
          address={`${p.property} · ${p.due}`}
          amount={p.amount}
          omitActionView
          checked={selection.isChecked(p.id)}
          onSelectedChange={(checked) => selection.set(p.id, checked)}
          onOpen={() => setRecord(p)}
          dataAttr="resident-payment-row"
        />
      ))}
    </ResidentListScreen>
  );
}

/**
 * `FixtureListScreen` with the one thing the resident Payments page needs that it has no slot for: cards between
 * the command bar and the list (Autopay, rent reporting, Pay all). Everything else is the same frame.
 */
export function ResidentListScreen({
  path,
  title,
  tabs,
  activeId,
  onTab,
  tabAriaLabel,
  search,
  onSearch,
  searchPlaceholder,
  belowBar,
  isEmpty,
  emptyTitle,
  emptySection,
  menu,
  onBulkClear,
  children,
  overlay,
}: {
  path: string;
  title: string;
  tabs: Array<{ id: string; label: string; count?: number; alert?: boolean }>;
  activeId: string;
  onTab: (id: string) => void;
  tabAriaLabel?: string;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  belowBar?: ReactNode;
  isEmpty: boolean;
  emptyTitle: string;
  emptySection?: string;
  menu?: ReactNode;
  onBulkClear?: () => void;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <ProductWindow path={path}>
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title={title} titleInlineFilter={null} hideTitleOnMobileNav compactFilterRow>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinationRow={
              tabs.length > 0 ? (
                <LocalDestinationNav appearance="command" ariaLabel={tabAriaLabel ?? `${title} views`} items={tabs} activeId={activeId} onChange={onTab} />
              ) : undefined
            }
            search={{ value: search, onChange: onSearch, placeholder: searchPlaceholder }}
          />
          {belowBar}
          <PortalRecordListSurface isEmpty={isEmpty} emptyCard={{ title: emptyTitle, section: emptySection }} bulkActions={menu} onBulkClear={onBulkClear}>
            {children}
          </PortalRecordListSurface>
        </ManagerPortalPageShell>
      </div>
      {overlay}
    </ProductWindow>
  );
}

/* ───────────────────────────── Services ───────────────────────────── */

const SERVICE_TABS = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];
const SERVICE_TAB_OF: Record<string, string> = { open: "open", scheduled: "scheduled", done: "completed", declined: "completed" };

export function ResidentServicesPanel({ story }: { story?: DemoStory } = {}) {
  const world = worldFor(story);
  const mine = useMemo(() => world.services.filter((s) => s.resident === RESIDENT_NAME), [world]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const live = useMemo(() => mine.filter((s) => !deletedIds.includes(s.id)), [mine, deletedIds]);
  const counts = useMemo(() => countBy(live, (s) => SERVICE_TAB_OF[s.state]!, ["open", "assigned", "scheduled", "completed"]), [live]);
  const jordan = mine[0] ? SERVICE_TAB_OF[mine[0].state]! : null;
  const [tab, setTab] = useState<string>(jordan ?? "open");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [adding, setAdding] = useState(false);
  const [record, setRecord] = useState<(typeof mine)[number] | null>(null);
  const [deleting, setDeleting] = useState<(typeof mine)[number] | null>(null);
  const rows = live.filter((s) => SERVICE_TAB_OF[s.state] === tab && matchesSearch(search, s.title, s.property));
  const selected = live.find((s) => s.id === selection.only);
  const canRemind = (s: (typeof mine)[number]) => s.state === "open" || s.state === "scheduled";

  if (record) {
    return (
      <ResidentRecordFrame path={`/resident/services/${record.id}`} toast={toastNode}>
        <ResidentServiceRecord
          service={record}
          onBack={() => setRecord(null)}
          onToast={show}
          onDeleted={() => {
            setDeletedIds((ids) => [...ids, record.id]);
            setRecord(null);
            show("Request deleted (sample)");
          }}
        />
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/services"
      title="Services"
      tabs={SERVICE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Service status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search services"
      primary={{ label: portalListAddPrimaryLabel("service"), onClick: () => setAdding(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "assigned" ? "Nothing assigned" : "No services in this status yet"}
      emptySection="services"
      menu={
        selected ? (
          <>
            {canRemind(selected) ? (
              <DropdownMenuItem data-attr="resident-service-request-send-reminder" onSelect={() => show("Reminder sent (sample)")}>
                Send reminder
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setDeleting(selected)}>Delete</DropdownMenuItem>
          </>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={
        <>
          {adding ? (
            <ResidentAddServiceModal
              onClose={() => setAdding(false)}
              onSent={() => {
                setAdding(false);
                show("Request sent (sample)");
              }}
            />
          ) : null}
          {deleting ? (
            <ResidentConfirmModal
              title="Delete service"
              description="Remove this service from your list?"
              confirmLabel="Delete"
              onClose={() => setDeleting(null)}
              onConfirm={() => {
                setDeletedIds((ids) => [...ids, deleting.id]);
                setDeleting(null);
                selection.clear();
                show("Service deleted (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {rows.map((s) => (
        <PortalApplicantRecordRow
          key={s.id}
          name={s.title}
          tileIcon={Wrench}
          address={`${s.property} · ${RESIDENT_HOME.room}`}
          facts={<PortalRowFact icon={CalendarDays}>{s.detail}</PortalRowFact>}
          omitActionView
          checked={selection.isChecked(s.id)}
          onSelectedChange={(checked) => selection.set(s.id, checked)}
          onOpen={() => setRecord(s)}
          dataAttr="resident-service-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Forms ───────────────────────────── */

const FORM_TABS = [
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
];

export function ResidentFormsPanel({ story }: { story?: DemoStory } = {}) {
  const base = residentForms(worldFor(story).story);
  const [submittedIds, setSubmittedIds] = useState<string[]>([]);
  const forms = useMemo<ResidentFormFixture[]>(
    () =>
      base.map((f) =>
        submittedIds.includes(f.id) ? { ...f, bucket: "completed" as const, fact: "Submitted just now", blocks: undefined } : f,
      ),
    [base, submittedIds],
  );
  const counts = useMemo(() => countBy(forms, (f) => f.bucket, ["pending", "completed"]), [forms]);
  const [tab, setTab] = useState<ResidentFormFixture["bucket"]>("pending");
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();
  const [flow, setFlow] = useState<ResidentFormFixture | null>(null);
  const rows = forms.filter((f) => f.bucket === tab);
  const selected = forms.find((f) => f.id === selection.only);

  if (flow) {
    return (
      <ResidentRecordFrame path={`/resident/forms/${flow.id}`} toast={toastNode}>
        <ResidentFormFlow
          form={flow}
          onBack={() => setFlow(null)}
          onToast={show}
          onSubmitted={() => {
            setSubmittedIds((ids) => [...ids, flow.id]);
            setFlow(null);
            setTab("completed");
            show("Submitted. Your manager has it. (sample)");
          }}
        />
      </ResidentRecordFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/resident/forms"
      title="Forms"
      tabs={FORM_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as ResidentFormFixture["bucket"]);
        selection.clear();
      }}
      tabAriaLabel="Forms"
      isEmpty={rows.length === 0}
      emptyTitle={tab === "pending" ? "No pending forms" : "No completed forms"}
      emptySection="forms"
      menu={
        selected ? (
          <DropdownMenuItem data-attr={selected.bucket === "completed" ? "resident-form-view" : "resident-form-fill"} onSelect={() => setFlow(selected)}>
            {selected.bucket === "completed" ? "View" : "Fill out"}
          </DropdownMenuItem>
        ) : undefined
      }
      onBulkClear={selection.clear}
      overlay={toastNode}
    >
      {rows.map((f) => (
        <PortalEntryRow
          key={f.id}
          tile={{ kind: "glyph", icon: FileText }}
          title={f.title}
          place={f.place}
          facts={[
            { icon: f.bucket === "completed" ? CheckCircle2 : Clock, label: f.fact },
            ...(f.blocks ? [{ icon: Lock, label: f.blocks }] : []),
          ]}
          checked={selection.isChecked(f.id)}
          onSelectedChange={(checked) => selection.set(f.id, checked)}
          onOpen={() => setFlow(f)}
          omitActionView
          selectLabel={f.title}
          dataAttr="resident-form-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

type Segment = "active" | "archived";

/**
 * The resident Communication two-pane (`ResidentUnifiedInbox`): the real list header (Active · Archived tabs, "Search
 * communication", the Filter popover with Status and About, the round + "New message" opening the real compose
 * modal), and a thread whose header carries Text / Email your property manager, Mark unread, Archive (an archived
 * conversation offers Restore and Delete). No Settings gear: the resident has none. Sending only appends locally.
 */
export function ResidentCommunicationPanel({ conversations }: { conversations: CommConversationFixture[] }) {
  const [state, setState] = useState<Record<string, { segment?: Segment; unread?: boolean; deleted?: boolean }>>({});
  const rows = useMemo(
    () =>
      conversations
        .filter((c) => !state[c.id]?.deleted)
        .map((c) => ({ ...c, segment: state[c.id]?.segment ?? c.segment, unread: state[c.id]?.unread ?? c.unread })),
    [conversations, state],
  );
  const [segment, setSegment] = useState<Segment>("active");
  const [selectedId, setSelectedId] = useState(conversations.find((c) => c.segment === "active")?.id ?? conversations[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CommunicationStatus>("active");
  const [about, setAbout] = useState("");
  const [composing, setComposing] = useState(false);
  const [sent, setSent] = useState<Record<string, { id: string; author: string; body: string; at: string; direction: "outbound" }[]>>({});
  const { show, node: toastNode } = useFixtureToast();
  // The list and thread sit side by side from the desktop breakpoint; below it the real inbox shows the list until
  // a row is opened, then the thread with a back arrow.
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

  const counts = useMemo(() => {
    const c = { active: 0, archived: 0 };
    for (const conv of rows) c[conv.segment] += 1;
    return c;
  }, [rows]);
  const visible = rows.filter(
    (c) =>
      c.segment === segment &&
      matchesSearch(query, c.name, c.subtitle, c.preview) &&
      (status === "unread" ? c.unread : status === "read" ? !c.unread : true) &&
      // The sample threads carry no record reference, so a kind in "About" narrows them to nothing, as the real list does.
      !about,
  );
  const selected = rows.find((c) => c.id === selectedId) ?? visible[0];
  const messages = selected ? [...selected.messages, ...(sent[selected.id] ?? [])] : [];
  const patch = (id: string, next: { segment?: Segment; unread?: boolean; deleted?: boolean }) => setState((s) => ({ ...s, [id]: { ...s[id], ...next } }));

  function send() {
    if (!draft.trim() || !selected) return;
    setSent((m) => ({
      ...m,
      [selected.id]: [...(m[selected.id] ?? []), { id: `local-${(m[selected.id]?.length ?? 0) + 1}`, author: RESIDENT_SELF, body: draft, at: "Just now", direction: "outbound" }],
    }));
    setDraft("");
    show("Sent");
  }

  const headerActions = selected ? (
    selected.segment === "archived" ? (
      <>
        <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Restore conversation" title="Restore" data-attr="inbox-thread-restore" onClick={() => { patch(selected.id, { segment: "active" }); show("Restored (sample)"); }}>
          <ArchiveRestore className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={INBOX_THREAD_ICON_BTN_DANGER} aria-label="Delete conversation" title="Delete" data-attr="inbox-thread-delete" onClick={() => { patch(selected.id, { deleted: true }); show("Deleted (sample)"); }}>
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </>
    ) : (
      <>
        <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Text your property manager" title="Text your property manager" data-attr="inbox-thread-text-manager" onClick={() => show("Text your property manager (sample)")}>
          <Phone className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Email your property manager" title="Email your property manager" data-attr="inbox-thread-email-manager" onClick={() => show("Email your property manager (sample)")}>
          <Mail className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Mark unread" title="Mark unread" data-attr="inbox-thread-mark-unread" disabled={selected.unread} onClick={() => patch(selected.id, { unread: true })}>
          <MailOpen className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Archive conversation" title="Archive" data-attr="inbox-thread-archive" onClick={() => { patch(selected.id, { segment: "archived" }); show("Archived (sample)"); }}>
          <Archive className="h-4 w-4" aria-hidden />
        </button>
      </>
    )
  ) : undefined;

  return (
    <ProductWindow path="/resident/communication/active">
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Communication" viewportFillBody>
          <InboxTwoPane
            threadOpen={wide || opened}
            fillParent
            panes="split"
            list={
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                <InboxListHeader
                  tabs={
                    <InboxListSegmentTabs
                      commBase="/resident/communication"
                      value={segment}
                      counts={counts}
                      onChange={setSegment}
                      interceptNavigation
                    />
                  }
                  search={{ value: query, onChange: setQuery, placeholder: "Search communication", ariaLabel: "Search messages", dataAttr: "resident-inbox-search" }}
                  count={visible.length}
                  trailing={
                    <div className="flex shrink-0 items-center gap-1 [&_button]:shrink-0 [&_a]:shrink-0" data-attr="communication-list-actions">
                      <DemoFilterSheet
                        activeCount={(status === "active" ? 0 : 1) + (about ? 1 : 0)}
                        compactPanel
                        filterFieldCount={2}
                        constrainDropdownToTitleBand={false}
                        commandStripTrigger
                        mobileFlushBody
                        onReset={() => {
                          setStatus("active");
                          setAbout("");
                        }}
                        dataAttr="resident-communication-filter-open"
                      >
                        <CommunicationStatusFilterDraft value={status} onChange={setStatus} hideArchived />
                        <FieldSingleSelect
                          label="About"
                          value={about}
                          onChange={setAbout}
                          options={[{ value: "", label: "All records" }, ...RECORD_KIND_FILTER_OPTIONS]}
                          placeholder="All records"
                          dataAttr="resident-communication-filter-about"
                        />
                      </DemoFilterSheet>
                      <PortalPrimaryIconAction label="New message" data-attr="communication-new-message" onClick={() => setComposing(true)} />
                    </div>
                  }
                />
                <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`}>
                  {visible.map((c) => (
                    <InboxConversationRow
                      key={c.id}
                      name={c.name}
                      subtitle={c.subtitle}
                      preview={c.preview}
                      time={c.time}
                      unread={c.unread}
                      selected={c.id === selected?.id}
                      onOpen={() => {
                        setSelectedId(c.id);
                        setOpened(true);
                        if (c.unread) patch(c.id, { unread: false });
                      }}
                    />
                  ))}
                </div>
              </div>
            }
            thread={
              selected ? (
                <InboxThreadView
                  title={selected.name}
                  subtitle={selected.subtitle}
                  avatarName={selected.name}
                  messages={messages}
                  onBack={() => setOpened(false)}
                  headerActions={headerActions}
                  composer={<InboxComposer value={draft} onChange={setDraft} onSubmit={send} placeholder="Write a message…" dataAttr="demo-panel-composer" />}
                />
              ) : null
            }
          />
        </ManagerPortalPageShell>
      </div>
      {composing ? (
        <ResidentComposeModal
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
