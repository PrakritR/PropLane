"use client";

/**
 * The vendor portal's tabs for the home page demo, drawn for Pacific Plumbing from the shared "Seattle Homes"
 * fixtures. Each mirrors its real page, read from the code (captain 2026-10-08: the pop-ups and record pages on the
 * home page must match the real portal):
 *
 *  - Services (`vendor-work-orders-panel.tsx`): Open · Assigned · Scheduled · Completed · Find work, a Filter popover,
 *    the Service settings gear, the round "Add bid" (the Submit bid wizard), real `VendorServiceCardRow` rows with a ⋯
 *    per stage, a row opens the service record page; Find work draws the real `VendorFindWorkList`
 *  - Calendar (`vendor-calendar-panel.tsx`): the manager calendar (Day · Week · Month · Agenda, Today and the range), the
 *    weekly open hours shaded, services as events; the band is Filter, Integrations (opens Settings > Integrations) and
 *    the round + (Block time, Weekly hours); a visit opens the quick-look
 *  - Reviews (`vendor-reviews-panel.tsx`): one list, newest first, no tabs and no stat cards; the "★ avg · n reviews"
 *    line (`reviewsSummary`) derived from the rows; star-tile rows, the Reply to review dialog
 *  - Finances (`vendor-finances-*.tsx`): Balance & payouts, Payments, Refunds, Statements and Tax info, the five
 *    sections the sidebar nests, each with its pop-ups and record pages
 *  - Documents (`vendor-documents-panel.tsx`) and Communication (`vendor-communication.tsx`)
 *
 * Settings gears navigate to a Settings page in the real portal, never a pop-up; here they are the same icon and only
 * show a small "(sample)" toast. Every pop-up and record page is loaded on demand (`demo-popups-lazy-vendor.tsx`).
 * The real panels fetch on mount, so these compose the same presentational pieces from fixtures.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  ArrowUpFromLine,
  CalendarDays,
  CalendarSync,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Clock,
  DollarSign,
  Download,
  FileText,
  Hammer,
  House,
  Landmark,
  Link2,
  Mail,
  MessageSquare,
  PenSquare,
  Pencil,
  RotateCcw,
  Settings,
  Sparkles,
  Undo2,
  UserRound,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterMultiSelectSummary,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { RecordBandFilter } from "@/components/portal/record-list-band";
import { VendorServiceCardRow } from "@/components/portal/pro-service-card-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { VendorFindWorkList } from "@/components/portal/vendor-find-work-list";
import { PortalStatStrip, type PortalStat } from "@/components/portal/portal-stat-strip";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection, PortalSettingsSections } from "@/components/portal/portal-settings-ui";
import type { DemoAvailabilityFocus } from "@/components/marketing/site/product-mock/demo-popups-vendor";
import { IntegrationRow } from "@/components/portal/integration-row";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { reviewsSummary } from "@/components/portal/vendor-reviews-panel";
import { VENDOR_INTEGRATION_PROVIDERS, type VendorIntegrationProvider } from "@/lib/vendor-integrations";
import { VendorRowMenu, type VendorRowMenuItem } from "@/components/portal/vendor-row-menu";
import { CommunicationStatusFilterDraft, type CommunicationStatus } from "@/components/portal/communication-status-filter";
import { InboxComposer, InboxConversationRow, InboxThreadView, InboxTwoPane } from "@/components/portal/portal-inbox-ui";
import { CalendarAgendaView, CalendarMonthView, CalendarTimeGrid, type CalendarGridItem } from "@/components/portal/manager-calendar-views";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { FIND_WORK_DISTANCE_OPTIONS, FIND_WORK_TRADE_OPTIONS } from "@/lib/vendor-find-work";
import { RECORD_KIND_FILTER_OPTIONS } from "@/lib/communication-thread-filters";
import { VENDOR_DOCUMENT_LABELS, VENDOR_DOCUMENT_SECTIONS, isVendorComplianceDocumentKind, type VendorDocumentKind } from "@/lib/vendor-documents";
import { statementMonthLabel } from "@/lib/vendor-banking/statement-events";
import { form1099StatusLabel, maskTin, vendorW9EntityLabel, type VendorTaxYearSummary } from "@/lib/vendor-banking/tax";
import type { PublicBoardServiceView } from "@/lib/public-service-projection";
import type { RecordKind } from "@/lib/portals/record-kinds";
import type { GridBand, GridWindow } from "@/lib/calendar-grid";
import {
  CALENDAR_NOW_MIN,
  CALENDAR_TODAY,
  CALENDAR_WEEK,
  AREA_BY_PROPERTY,
  VENDOR_CONVERSATIONS,
  VENDOR_NAME,
  VENDOR_REVIEWS,
  type CommConversationFixture,
  type VendorReviewFixture,
  type VendorServiceFixture,
} from "@/components/marketing/site/product-mock/fixtures";
import { VENDOR_CHECKLIST, VENDOR_PAYOUTS, type VendorPayoutFixture } from "@/components/marketing/site/product-mock/fixtures-more";
import {
  DEMO_AVAILABLE_CENTS,
  DEMO_BANK,
  DEMO_MANAGER_DOCUMENTS,
  DEMO_REFUNDS,
  DEMO_STATEMENTS,
  DEMO_TAX_YEARS,
  DEMO_W9,
  DEMO_WEEKLY_WINDOWS,
  EXTRA_VENDOR_PAYMENTS,
  EXTRA_VENDOR_SERVICES,
  FIND_WORK_BOARD,
  demoVendorServiceActions,
  jobBidState,
  jobDetailFor,
  statementClosingCents,
  type VendorJobDetail,
} from "@/components/marketing/site/product-mock/fixtures-popups-vendor";
import {
  vendorPayments,
  vendorServices,
  vendorStory,
  vendorVisit,
  type DemoStory,
  type VendorVisit,
} from "@/components/marketing/site/product-mock/world";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { DEMO_PAGE_CLASS, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import {
  DemoVendorAddBankDialog,
  DemoVendorAvailabilityDialog,
  DemoVendorComposeDialog,
  DemoVendorDocumentViewer,
  DemoVendorInvoiceRecord,
  DemoVendorJobRecord,
  DemoVendorPaymentRecord,
  DemoVendorQuoteWizard,
  DemoVendorRefundDialog,
  DemoVendorReplyDialog,
  DemoVendorStatementDialog,
  DemoVendorUploadDocumentPopup,
  DemoVendorVisitDialog,
  DemoVendorW9Dialog,
  DemoVendorWithdrawDialog,
  DemoVendorWithdrawalRecord,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-vendor";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseMoney = (s: string) => Number(s.replace(/[$,]/g, ""));
const cents = (n: number) => money(n / 100);

/** A page outside the list frame (a record page, the Refunds list): the same window and page padding. */
function PageFrame({ path, children, overlay }: { path: string; children: ReactNode; overlay?: ReactNode }) {
  return (
    <ProductWindow path={path}>
      <div className={DEMO_PAGE_CLASS}>{children}</div>
      {overlay}
    </ProductWindow>
  );
}

/** The messages a service's Communication section opens with: the Alder House thread, or one line from the manager. */
function jobMessages(title: string, place: string) {
  if (place.startsWith("Alder House")) return VENDOR_CONVERSATIONS[0]!.messages;
  return [{ id: "m1", author: "Manager", body: `Thanks for taking a look at ${title}.`, at: "Sep 24, 2:10 PM", direction: "inbound" as const }];
}

/* ───────────────────────────── Services ───────────────────────────── */

type ServiceTab = "open" | "assigned" | "scheduled" | "completed";
/** `VENDOR_WORK_ORDER_TABS` (the stage vocabulary), then the appended Find work tab (`VENDOR_FIND_WORK_TAB`). */
const SERVICE_TABS: { id: string; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
  { id: "find-work", label: "Find work" },
];
const FACT_ICON: Record<VendorServiceFixture["factIcon"], LucideIcon> = {
  clock: Clock,
  sparkles: Sparkles,
  calendar: CalendarDays,
  check: Check,
};
/** How far each published job is from the vendor, for the Find work Distance filter. */
const FIND_WORK_MILES: Record<string, number> = { "board-1": 3, "board-2": 8, "board-3": 4 };

/** The place line: a vendor not hired yet sees only the general area. */
function placeLine(s: VendorServiceFixture): string {
  if (!s.hired) return AREA_BY_PROPERTY[s.property] ?? s.property;
  return s.unit ? `${s.property} · ${s.unit}` : s.property;
}

type ServiceTarget = {
  job: { id: string; title: string; placeLine: string; hired: boolean; stage: ServiceTab; fact: string; figure?: string; manager: string };
  detail: VendorJobDetail;
  section?: string;
  choice?: "submit_bid" | "book_estimate_visit";
};

function targetForService(s: VendorServiceFixture, section?: string, choice?: ServiceTarget["choice"]): ServiceTarget {
  const base = jobDetailFor(s.id);
  return {
    job: { id: s.id, title: s.title, placeLine: placeLine(s), hired: s.hired, stage: s.state, fact: s.fact, figure: s.figure, manager: "Manager" },
    detail: { ...base, bid: jobBidState(s.id, s.fact) },
    section,
    choice,
  };
}

function targetForBoard(service: PublicBoardServiceView, section: string, choice?: ServiceTarget["choice"]): ServiceTarget {
  return {
    job: { id: service.ref, title: service.title, placeLine: [service.area, service.trade].filter(Boolean).join(" · "), hired: false, stage: "open", fact: service.when || "Anytime", manager: service.postedBy || "Manager" },
    detail: { trade: service.trade, description: service.description, bid: "none", budget: service.budget || undefined },
    section,
    choice,
  };
}

/** A service's record page inside its own window, with the pop-ups it opens (Request payment) and the toast. */
function ServiceRecordScreen({
  target,
  onBack,
  invoiced,
  onInvoiced,
  onCompleted,
}: {
  target: ServiceTarget;
  onBack: () => void;
  invoiced: boolean;
  onInvoiced: () => void;
  onCompleted: () => void;
}) {
  const { show, node: toastNode } = useFixtureToast();
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const { job } = target;
  return (
    <PageFrame
      path={`/vendor/work-orders/${job.id}`}
      overlay={
        <>
          {invoiceOpen ? (
            <DemoVendorQuoteWizard
              door="invoice"
              jobs={[{ id: job.id, title: job.title, place: job.placeLine }]}
              initialJobId={job.id}
              onClose={() => setInvoiceOpen(false)}
              onDone={() => {
                setInvoiceOpen(false);
                onInvoiced();
                show("Payment requested (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      <DemoVendorJobRecord
        job={job}
        detail={target.detail}
        messages={jobMessages(job.title, job.placeLine)}
        initialSection={target.section}
        initialBidChoice={target.choice}
        onBack={onBack}
        onToast={show}
        onRequestInvoice={() => setInvoiceOpen(true)}
        onCompleted={onCompleted}
        invoiceSent={invoiced}
      />
    </PageFrame>
  );
}

export function VendorServicesPanel({ story }: { story?: DemoStory } = {}) {
  const base = useMemo(() => [...vendorServices(story ?? vendorStory(undefined)), ...EXTRA_VENDOR_SERVICES], [story]);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [invoicedIds, setInvoicedIds] = useState<string[]>([]);
  // A service marked Complete moves to Completed with its invoice still owed; a requested payment reads "Invoice sent".
  const services = useMemo(
    () =>
      base.map((s) => {
        const done = completedIds.includes(s.id) && s.state !== "completed";
        const next: VendorServiceFixture = done ? { ...s, state: "completed", fact: "No invoice yet", factIcon: "check" } : s;
        return invoicedIds.includes(s.id) ? { ...next, fact: "Invoice sent", factIcon: "check" as const } : next;
      }),
    [base, completedIds, invoicedIds],
  );
  const counts = useMemo(() => countBy(services, (s) => s.state, ["open", "assigned", "scheduled", "completed"]), [services]);
  // The faucet job is the first row whenever the story has reached the vendor.
  const jordan = services[0]?.id === "vsvc-willow-faucet" ? services[0].state : null;
  const [tab, setTab] = useState<string>(jordan ?? "open");
  useEffect(() => {
    if (jordan !== null) setTab(jordan);
  }, [jordan]);
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [tradeFilter, setTradeFilter] = useState("");
  const [distanceFilter, setDistanceFilter] = useState("");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [invoiceFor, setInvoiceFor] = useState<VendorServiceFixture | null>(null);
  const [record, setRecord] = useState<ServiceTarget | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const isFindWork = tab === "find-work";
  const propertyOptions = useMemo(() => [...new Set(services.map((s) => s.property))].sort().map((name) => ({ value: name, label: name })), [services]);
  const board = FIND_WORK_BOARD.filter(
    (b) =>
      matchesSearch(search, b.title, b.area, b.trade, b.postedBy) &&
      (!tradeFilter || FIND_WORK_TRADE_OPTIONS.find((o) => o.value === tradeFilter)?.label === b.trade) &&
      (!distanceFilter || (FIND_WORK_MILES[b.ref] ?? 0) <= Number(distanceFilter)),
  );
  const rows = services.filter((s) => s.state === tab && (!propertyFilter || s.property === propertyFilter) && matchesSearch(search, s.title, s.property));
  const nearYou = tab === "open" ? rows.filter((s) => !s.hired && jobBidState(s.id, s.fact) === "none") : [];
  const others = tab === "open" ? rows.filter((s) => !nearYou.includes(s)) : rows;
  const wizardJobs = services.filter((s) => s.state === "open").map((s) => ({ id: s.id, title: s.title, place: placeLine(s) }));

  const openRecord = (s: VendorServiceFixture, section?: string, choice?: ServiceTarget["choice"]) => setRecord(targetForService(s, section, choice));

  const renderRow = (s: VendorServiceFixture) => {
    const detail = { ...jobDetailFor(s.id), bid: jobBidState(s.id, s.fact) };
    const invoiceOwed = s.state === "completed" && detail.invoice === "owed" && !invoicedIds.includes(s.id) && s.fact === "No invoice yet";
    const actions = demoVendorServiceActions(s.state, detail, !s.hired, invoiceOwed);
    const run = (id: string) => {
      if (id === "submit_bid") openRecord(s, "bid", "submit_bid");
      else if (id === "book_visit") openRecord(s, "bid", "book_estimate_visit");
      else if (id === "visit_done" || id === "decline") openRecord(s, "bid");
      else if (id === "schedule" || id === "reschedule") openRecord(s, "schedule");
      else if (id === "message") openRecord(s, "communication");
      else if (id === "mark_done") {
        setCompletedIds((cur) => [...cur, s.id]);
        show("Marked complete (sample)");
      } else if (id === "send_invoice") setInvoiceFor(s);
    };
    return (
      <div key={s.id} id={`portal-work-order-${s.id}`}>
        <VendorServiceCardRow
          title={s.title}
          placeLine={placeLine(s)}
          dateText={s.fact}
          icon={FACT_ICON[s.factIcon]}
          figure={s.figure}
          onOpen={() => openRecord(s)}
          actions={
            actions.length > 0 ? (
              <RowActionsMenu label={s.title} items={actions.map((a) => ({ id: a.id, label: a.label, danger: a.id === "decline", dataAttr: `vendor-service-action-${a.id}`, onSelect: () => run(a.id) }))} />
            ) : undefined
          }
          dataAttr="vendor-service-row"
        />
      </div>
    );
  };

  if (record) {
    const id = record.job.id;
    return (
      <ServiceRecordScreen
        key={id}
        target={record}
        onBack={() => setRecord(null)}
        invoiced={invoicedIds.includes(id)}
        onInvoiced={() => setInvoicedIds((cur) => [...cur, id])}
        onCompleted={() => setCompletedIds((cur) => [...cur, id])}
      />
    );
  }

  const emptyTitle = isFindWork ? "No work on the board" : tab === "open" ? "No open services" : tab === "assigned" ? "Nothing assigned" : tab === "scheduled" ? "Nothing scheduled" : "Nothing completed yet";

  return (
    <FixtureListScreen
      path="/vendor/work-orders"
      title="Services"
      tabs={SERVICE_TABS.map((t) => ({ ...t, count: t.id === "find-work" ? FIND_WORK_BOARD.length : counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Service status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search services"
      actions={
        <>
          <RecordBandFilter
            dataAttr="vendor-services-band"
            fields={
              isFindWork
                ? [
                    { id: "trade", label: "Trade", anyLabel: "Any trade", value: tradeFilter, options: FIND_WORK_TRADE_OPTIONS, onChange: setTradeFilter },
                    { id: "distance", label: "Distance", anyLabel: "Any distance", value: distanceFilter, options: FIND_WORK_DISTANCE_OPTIONS, onChange: setDistanceFilter },
                  ]
                : propertyOptions.length > 0
                  ? [{ id: "property", label: "Property", anyLabel: "Any property", value: propertyFilter, options: propertyOptions, onChange: setPropertyFilter }]
                  : []
            }
          />
          <PortalIconAction icon={Settings} label="Service settings" data-attr="vendor-services-settings-gear" onClick={() => show("Service settings (sample)")} />
        </>
      }
      primary={{ label: "Add bid", onClick: () => setQuoteOpen(true) }}
      isEmpty={isFindWork ? board.length === 0 : rows.length === 0}
      emptyTitle={emptyTitle}
      emptySection="services"
      overlay={
        <>
          {quoteOpen ? (
            <DemoVendorQuoteWizard
              door="quote"
              jobs={wizardJobs}
              onClose={() => setQuoteOpen(false)}
              onDone={() => {
                setQuoteOpen(false);
                show("Bid submitted (sample)");
              }}
            />
          ) : null}
          {invoiceFor ? (
            <DemoVendorQuoteWizard
              door="invoice"
              jobs={[{ id: invoiceFor.id, title: invoiceFor.title, place: placeLine(invoiceFor) }]}
              initialJobId={invoiceFor.id}
              onClose={() => setInvoiceFor(null)}
              onDone={() => {
                setInvoicedIds((cur) => [...cur, invoiceFor.id]);
                setInvoiceFor(null);
                show("Payment requested (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {isFindWork ? (
        <VendorFindWorkList
          services={board}
          busy={null}
          onChoose={(service, choice) =>
            setRecord(targetForBoard(service, choice === "message" ? "communication" : "bid", choice === "bid" ? "submit_bid" : choice === "estimate" ? "book_estimate_visit" : undefined))
          }
        />
      ) : (
        <>
          {nearYou.length > 0 ? <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Near you</p> : null}
          {nearYou.map(renderRow)}
          {others.map(renderRow)}
        </>
      )}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Calendar ───────────────────────────── */

/** The manager calendar's own view switch (`VendorCalendarPanel` has no tabs: Day · Week · Month · Agenda). */
const CALENDAR_VIEW_OPTIONS = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "agenda", label: "Agenda" },
];
const CALENDAR_NAV_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-accent hover:text-foreground active:scale-95";
const INTEGRATION_PROVIDER_ICONS: Record<VendorIntegrationProvider, { icon: LucideIcon; tone: string }> = {
  jobber: { icon: Wrench, tone: "text-emerald-600" },
  housecall_pro: { icon: House, tone: "text-blue-600" },
  thumbtack: { icon: Hammer, tone: "text-sky-600" },
};
const GRID_WINDOW: GridWindow = { from: 8 * 60, to: 19 * 60, early: 0, late: 0 };

type VisitFixture = VendorVisit;
/** Pacific Plumbing's visits this week — the same services the Services tab lists. */
const VISITS: VisitFixture[] = [
  { id: "visit-disposal", dateStr: "2025-09-22", startMin: 13 * 60, durationMin: 60, title: "Garbage disposal repair", place: "Fremont Studio" },
  { id: "visit-faucet", dateStr: "2025-09-25", startMin: 10 * 60, durationMin: 120, title: "Kitchen faucet drip", place: "Alder House" },
];
/** The week after the standing one, where the Willow Court faucet visit lands (Thursday, Oct 2). */
const NEXT_WEEK = ["2025-09-29", "2025-09-30", "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05"];

function clock(min: number): string {
  const h = Math.floor(min / 60);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${min % 60 ? `:${String(min % 60).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

function visitToGridItem(v: VisitFixture): CalendarGridItem {
  return {
    id: v.id,
    kind: "service",
    dateStr: v.dateStr,
    startMin: v.startMin,
    durationMin: v.durationMin,
    allDay: false,
    title: v.title,
    place: v.place,
    requested: false,
    person: null,
    meeting: { id: v.id, source: "planned", sourceId: v.id, dateStr: v.dateStr, title: v.title, kind: "service" } as unknown as DemoMeeting,
  };
}

function shortDate(ds: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${ds}T12:00:00`).toLocaleDateString("en-US", options);
}

/**
 * Vendor Settings > Integrations (`vendor-integrations-settings.tsx`), drawn static: grouped rows (Messages, Calendar, Job
 * software), one icon tile each, one plain fact and one action on the right. The real page fetches the work identity and
 * the calendar link; here they are fixtures, and Manage / Connect / Request access only show a "(sample)" toast.
 */
function VendorIntegrationsScreen({ onBack }: { onBack: () => void }) {
  const { show, node: toastNode } = useFixtureToast();
  const [requested, setRequested] = useState<string[]>([]);
  const link = "https://proplane.ai/api/calendar/vendor/pacific/calendar-link.ics";
  return (
    <PageFrame path="/vendor/settings?tab=integrations" overlay={toastNode}>
      <ManagerPortalPageShell title="Settings" titleInlineFilter={null} hideTitleOnMobileNav compactFilterRow>
        <div className="mb-3 flex items-center gap-2 px-1">
          <PortalIconAction icon={ArrowLeft} label="Back to Calendar" data-attr="vendor-integrations-back" onClick={onBack} />
          <h2 className="text-lg font-semibold text-foreground">Integrations</h2>
        </div>
        <PortalSettingsSections>
          <div data-attr="vendor-integrations-section-messages">
            <PortalSettingsSection title="Messages">
              <PortalSettingsGroup>
                <IntegrationRow icon={MessageSquare} tone="text-emerald-600" name="Work number" fact="(425) 555-0177" dataAttr="vendor-integrations-number-row" action={<Button variant="ghost" onClick={() => show("Manage work number (sample)")}>Manage</Button>} />
                <IntegrationRow icon={Mail} tone="text-blue-600" name="Work email" fact="pacific@vendors.proplane.ai" dataAttr="vendor-integrations-email-row" action={<Button variant="ghost" onClick={() => show("Manage work email (sample)")}>Manage</Button>} />
              </PortalSettingsGroup>
            </PortalSettingsSection>
          </div>
          <div data-attr="vendor-integrations-section-calendar">
            <PortalSettingsSection title="Calendar">
              <PortalSettingsGroup>
                <IntegrationRow icon={Link2} tone="text-blue-500" name="Google Calendar" dataAttr="integrations-google-calendar-row" action={<Button variant="ghost" onClick={() => show("Connect Google Calendar (sample)")}>Connect</Button>} />
                <IntegrationRow
                  icon={Link2}
                  tone="text-violet-600"
                  name="Calendar link"
                  dataAttr="vendor-integrations-calendar-link"
                  fact={<span className="hidden max-w-[16rem] truncate font-mono sm:inline-block">{link}</span>}
                  action={
                    <div className="flex items-center gap-1">
                      <PortalIconAction icon={Copy} label="Copy link" onClick={() => show("Calendar link copied (sample)")} />
                      <PortalIconAction icon={RotateCcw} label="Reset link" onClick={() => show("Calendar link reset (sample)")} />
                    </div>
                  }
                />
              </PortalSettingsGroup>
            </PortalSettingsSection>
          </div>
          <div data-attr="vendor-integrations-section-job-software">
            <PortalSettingsSection title="Job software">
              <PortalSettingsGroup>
                {VENDOR_INTEGRATION_PROVIDERS.map((provider) => {
                  const glyph = INTEGRATION_PROVIDER_ICONS[provider.id];
                  return requested.includes(provider.id) ? (
                    <IntegrationRow key={provider.id} icon={glyph.icon} tone={glyph.tone} name={provider.label} dataAttr={`vendor-integrations-${provider.id}-row`} action={<span className="text-sm text-muted">Requested</span>} />
                  ) : (
                    <IntegrationRow
                      key={provider.id}
                      icon={glyph.icon}
                      tone={glyph.tone}
                      name={provider.label}
                      comingSoon
                      dataAttr={`vendor-integrations-${provider.id}-row`}
                      comingSoonAction={<Button variant="ghost" onClick={() => setRequested((cur) => [...cur, provider.id])}>Request access</Button>}
                    />
                  );
                })}
              </PortalSettingsGroup>
            </PortalSettingsSection>
          </div>
        </PortalSettingsSections>
      </ManagerPortalPageShell>
    </PageFrame>
  );
}

export function VendorCalendarPanel({ story }: { story?: DemoStory } = {}) {
  const current = story ?? vendorStory(undefined);
  const visit = vendorVisit(current);
  // The grid shows the week the story's visit is in.
  const week = visit ? NEXT_WEEK : CALENDAR_WEEK;
  const today = week.includes(CALENDAR_TODAY) ? CALENDAR_TODAY : week[0]!;
  /** Open hours: Monday to Friday, 8 AM to 4 PM (the weekly hours the Weekly hours pop-up edits). */
  const availabilityDays = week.slice(0, DEMO_WEEKLY_WINDOWS.length);
  const allVisits = useMemo(() => [...(visit ? [visit] : []), ...VISITS].filter((v) => week.includes(v.dateStr)), [visit, week]);
  const [view, setView] = useState("week");
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [selected, setSelected] = useState<VisitFixture | null>(null);
  const [availabilityFocus, setAvailabilityFocus] = useState<DemoAvailabilityFocus | null>(null);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [record, setRecord] = useState<ServiceTarget | null>(null);
  const [invoicedIds, setInvoicedIds] = useState<string[]>([]);
  const { show, node: toastNode } = useFixtureToast();

  const propertyOptions = useMemo(() => [...new Set(allVisits.map((v) => v.place.split(" · ")[0]!))].sort().map((value) => ({ value, label: value })), [allVisits]);
  const visits = allVisits.filter((v) => propertyFilters.length === 0 || propertyFilters.includes(v.place.split(" · ")[0]!));
  const items = useMemo(() => visits.filter((v) => matchesSearch(search, v.title, v.place)).map(visitToGridItem), [visits, search]);
  const bandsByDate = useMemo(() => {
    const map = new Map<string, GridBand[]>();
    for (const ds of availabilityDays) map.set(ds, [{ startMin: 8 * 60, endMin: 16 * 60, kinds: ["services"], source: "typed" }]);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week]);
  const noop = () => undefined;
  const openEditor = (focus: DemoAvailabilityFocus) => setAvailabilityFocus(focus);

  const serviceFor = (title: string) => [...vendorServices(current), ...EXTRA_VENDOR_SERVICES].find((s) => s.title === title);
  const openService = (title: string, section?: string) => {
    const s = serviceFor(title);
    if (s) setRecord(targetForService(s, section));
    setSelected(null);
  };
  const openItem = (item: CalendarGridItem) => setSelected(visits.find((v) => v.id === item.id) ?? null);

  if (record) {
    return (
      <ServiceRecordScreen
        key={record.job.id}
        target={record}
        onBack={() => setRecord(null)}
        invoiced={invoicedIds.includes(record.job.id)}
        onInvoiced={() => setInvoicedIds((cur) => [...cur, record.job.id])}
        onCompleted={noop}
      />
    );
  }
  if (integrationsOpen) return <VendorIntegrationsScreen onBack={() => setIntegrationsOpen(false)} />;

  const filterSheet =
    propertyOptions.length > 1 ? (
      <DemoFilterSheet activeCount={portalFilterActiveCount([propertyFilters])} onReset={() => setPropertyFilters([])} dataAttr="vendor-calendar-filter-open" commandStripTrigger>
        <FilterCollapsibleSection
          label="Property"
          summary={propertyFilters.length ? propertyFilters.join(", ") : "All properties"}
          empty={propertyFilters.length === 0}
          sectionId="property"
          menuOptionCount={propertyOptions.length}
          dataAttr="vendor-calendar-filter-property"
        >
          <FilterCheckboxList options={propertyOptions} selected={propertyFilters} onChange={setPropertyFilters} dataAttr="vendor-calendar-filter-property-list" />
        </FilterCollapsibleSection>
      </DemoFilterSheet>
    ) : null;

  const dates = view === "day" ? [today] : week;
  const rangeLabel =
    view === "day"
      ? shortDate(today, { weekday: "short", month: "short", day: "numeric" })
      : view === "month"
        ? shortDate(week[0]!, { month: "long", year: "numeric" })
        : `${shortDate(week[0]!, { month: "short", day: "numeric" })} - ${shortDate(week[6]!, { month: "short", day: "numeric" })}`;
  const navUnit = view === "agenda" ? "week" : view;

  return (
    <FixtureListScreen
      path="/vendor/calendar"
      title="Calendar"
      tabs={[]}
      activeId=""
      onTab={noop}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search calendar"
      actions={
        <>
          {filterSheet}
          <PortalIconAction icon={CalendarSync} label="Integrations" badge="warn" data-attr="vendor-calendar-integrations-btn" onClick={() => setIntegrationsOpen(true)} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PortalPrimaryIconAction label="Add to calendar" data-attr="vendor-calendar-add-menu" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-attr="vendor-calendar-add-menu-content">
              <DropdownMenuItem data-attr="vendor-calendar-block-time" onSelect={() => openEditor("block")}>
                Block time
              </DropdownMenuItem>
              <DropdownMenuItem data-attr="vendor-calendar-weekly-hours" onSelect={() => openEditor("weekly")}>
                Weekly hours
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      isEmpty={false}
      emptyTitle=""
      surface={false}
      overlay={
        <>
          {availabilityFocus ? (
            <DemoVendorAvailabilityDialog
              focus={availabilityFocus}
              onClose={() => setAvailabilityFocus(null)}
              onSaved={() => {
                setAvailabilityFocus(null);
                show("Availability saved (sample)");
              }}
            />
          ) : null}
          {selected ? (
            <DemoVendorVisitDialog
              title={selected.title}
              rows={[
                { label: "When", value: `${shortDate(selected.dateStr, { weekday: "short", month: "short", day: "numeric" })} · ${clock(selected.startMin)} – ${clock(selected.startMin + selected.durationMin)}` },
                { label: "Property", value: selected.place },
              ]}
              onClose={() => setSelected(null)}
              onOpen={() => openService(selected.title)}
              onMessage={() => openService(selected.title, "communication")}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-1" data-attr="calendar-toolbar">
          <LocalDestinationNav
            appearance="command"
            ariaLabel="Calendar view"
            activeId={view}
            onChange={setView}
            items={CALENDAR_VIEW_OPTIONS.map((option) => ({ ...option, dataAttr: `calendar-view-mode-${option.id}` }))}
            className="w-auto max-w-full"
          />
          <div className="flex min-w-0 items-center gap-1" data-attr="calendar-nav">
            <button type="button" className="h-7 shrink-0 rounded-md px-2 text-[13px] font-semibold text-muted transition hover:bg-accent hover:text-foreground" data-attr="calendar-today" onClick={() => show("Today (sample)")}>
              Today
            </button>
            <button type="button" className={CALENDAR_NAV_BUTTON_CLASS} aria-label={`Previous ${navUnit}`} data-attr="calendar-nav-prev" onClick={() => show(`Previous ${navUnit} (sample)`)}>
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <span className="min-w-0 truncate whitespace-nowrap px-0.5 text-[13px] text-muted" data-attr="calendar-range-label">
              {rangeLabel}
            </span>
            <button type="button" className={CALENDAR_NAV_BUTTON_CLASS} aria-label={`Next ${navUnit}`} data-attr="calendar-nav-next" onClick={() => show(`Next ${navUnit} (sample)`)}>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-border bg-card">
          {view === "agenda" ? (
            <div className="p-3">
              <CalendarAgendaView dates={week} items={items} todayDs={today} onOpenItem={openItem} />
            </div>
          ) : view === "month" ? (
            <CalendarMonthView
              monthStart={`${week[0]!.slice(0, 7)}-01`}
              items={items}
              todayDs={today}
              phone={false}
              openHalfHoursFor={(ds) => (bandsByDate.has(ds) ? 16 : 0)}
              openLabel="Open hours"
              onOpenItem={openItem}
              onOpenDay={() => setView("day")}
            />
          ) : (
            <CalendarTimeGrid
              dates={dates}
              items={items}
              bandsByDate={bandsByDate}
              window={GRID_WINDOW}
              expandEarly={false}
              expandLate={false}
              onToggleEarly={noop}
              onToggleLate={noop}
              todayDs={today}
              nowMin={CALENDAR_NOW_MIN}
              isDay={view === "day"}
              canEditAvailability={false}
              onOpenItem={openItem}
              onOpenDay={() => setView("day")}
              onBandClick={() => openEditor("all")}
              onDragAdd={() => openEditor("block")}
              minColumnPx={view === "day" ? 128 : 96}
            />
          )}
        </div>
      </div>
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Payments ───────────────────────────── */

type PaymentRow = {
  id: string;
  title: string;
  place: string;
  date: string;
  /** yyyy-mm-dd, for the date filter. */
  iso: string;
  due?: string;
  status: string;
  amount: string;
  manager: string;
  bucket: "pending" | "paid" | "overdue";
  /** The matching payout, when money has moved. */
  payoutId?: string;
};

const PAYOUT_OF_PAYMENT: Record<string, string> = { "vpay-drain": "payout-3", "vpay-heater": "payout-2" };

function isoOf(label: string): string {
  const d = new Date(label);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function paymentRows(story: DemoStory): PaymentRow[] {
  const fromWorld: PaymentRow[] = vendorPayments(story).map((p) => ({
    id: p.id,
    title: p.title,
    place: p.place,
    date: p.date,
    iso: isoOf(p.date),
    status: p.status,
    amount: p.amount,
    manager: "Seattle Homes",
    bucket: p.status === "Paid" ? "paid" : "pending",
    payoutId: PAYOUT_OF_PAYMENT[p.id],
  }));
  const overdue: PaymentRow[] = EXTRA_VENDOR_PAYMENTS.map((p) => ({ ...p, iso: isoOf(p.date), bucket: "overdue" as const }));
  return [...fromWorld, ...overdue];
}

/** `VENDOR_PAYMENT_BUCKETS`: Pending · Paid · Overdue. */
const PAYMENT_TABS = [
  { id: "pending", label: "Pending" },
  { id: "paid", label: "Paid" },
  { id: "overdue", label: "Overdue" },
] as const;

type PaymentTarget = { kind: "invoice" | "payment"; row: PaymentRow };

export function VendorPaymentsPanel({ story }: { story?: DemoStory } = {}) {
  const rowsAll = useMemo(() => paymentRows(story ?? vendorStory(undefined)), [story]);
  const [bucket, setBucket] = useState<(typeof PAYMENT_TABS)[number]["id"]>("pending");
  const [search, setSearch] = useState("");
  const [statusIds, setStatusIds] = useState<string[]>([]);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [requestOpen, setRequestOpen] = useState(false);
  const [editRow, setEditRow] = useState<PaymentRow | null>(null);
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [retracted, setRetracted] = useState<string[]>([]);
  const [record, setRecord] = useState<PaymentTarget | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  const live = rowsAll.filter((r) => !retracted.includes(r.id));
  const counts = countBy(live, (r) => r.bucket, ["pending", "paid", "overdue"]);
  const statusOptions = [...new Set(live.map((r) => r.status))].map((value) => ({ value, label: value }));
  const propertyOptions = [...new Set(live.map((r) => r.place.split(" · ")[0]!))].sort().map((value) => ({ value, label: value }));
  const rows = live.filter(
    (r) =>
      r.bucket === bucket &&
      matchesSearch(search, r.title, r.place, r.status, r.manager) &&
      (statusIds.length === 0 || statusIds.includes(r.status)) &&
      (propertyIds.length === 0 || propertyIds.includes(r.place.split(" · ")[0]!)) &&
      (!from || r.iso >= from) &&
      (!to || r.iso <= to),
  );
  const filtersActive = statusIds.length + propertyIds.length + (from ? 1 : 0) + (to ? 1 : 0);
  const refundable = (r: PaymentRow) => Boolean(r.payoutId);

  if (record) {
    const back = () => setRecord(null);
    if (record.kind === "invoice") {
      return (
        <PageFrame
          path={`/vendor/financials/invoices/${record.row.id}`}
          overlay={
            <>
              {editRow ? (
                <DemoVendorQuoteWizard door="invoice" jobs={[{ id: editRow.id, title: editRow.title, place: editRow.place }]} initialJobId={editRow.id} onClose={() => setEditRow(null)} onDone={() => { setEditRow(null); show("Invoice updated (sample)"); }} />
              ) : null}
              {toastNode}
            </>
          }
        >
          <DemoVendorInvoiceRecord
            invoice={{ id: record.row.id, number: record.row.title, place: record.row.place, date: record.row.date, status: record.row.status, amount: record.row.amount, manager: record.row.manager, service: record.row.place }}
            messages={VENDOR_CONVERSATIONS[1]!.messages}
            onBack={back}
            onToast={show}
            onEdit={() => setEditRow(record.row)}
          />
        </PageFrame>
      );
    }
    const amountCents = Math.round(parseMoney(record.row.amount) * 100);
    return (
      <PageFrame
        path={`/vendor/financials/payouts/${record.row.payoutId ?? record.row.id}`}
        overlay={
          <>
            {refundFor ? <DemoVendorRefundDialog initialPaymentId={refundFor} onClose={() => setRefundFor(null)} onDone={() => { setRefundFor(null); show("Refund started (sample)"); }} /> : null}
            {toastNode}
          </>
        }
      >
        <DemoVendorPaymentRecord
          payment={{ id: record.row.id, title: record.row.title, place: record.row.place, date: record.row.date, amountCents, feeCents: Math.round(amountCents * 0.05), manager: record.row.manager }}
          messages={VENDOR_CONVERSATIONS[1]!.messages}
          onBack={back}
          onToast={show}
          onRefund={() => setRefundFor(record.row.payoutId ?? DEMO_REFUNDS[0]!.id)}
        />
      </PageFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/vendor/payments/pending"
      title="Incoming payments"
      tabs={PAYMENT_TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts.overdue > 0 }))}
      activeId={bucket}
      onTab={(id) => setBucket(id as typeof bucket)}
      tabAriaLabel="Payment status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search payments"
      actions={
        <>
          <DemoFilterSheet
            activeCount={filtersActive}
            compactPanel
            commandStripTrigger
            filterFieldCount={4}
            onReset={() => {
              setStatusIds([]);
              setPropertyIds([]);
              setFrom("");
              setTo("");
            }}
            dataAttr="vendor-finances-filter-open"
          >
            <FilterFieldsAccordion>
              <FilterCollapsibleSection sectionId="status" label="Status" summary={filterMultiSelectSummary(statusIds, statusOptions)} empty={statusIds.length === 0} menuOptionCount={Math.max(1, statusOptions.length)}>
                <FilterCheckboxList options={statusOptions} selected={statusIds} onChange={setStatusIds} dataAttr="vendor-finances-filter-status" />
              </FilterCollapsibleSection>
              <FilterCollapsibleSection sectionId="property" label="Property" summary={filterMultiSelectSummary(propertyIds, propertyOptions)} empty={propertyIds.length === 0} menuOptionCount={Math.max(1, propertyOptions.length)}>
                <FilterCheckboxList options={propertyOptions} selected={propertyIds} onChange={setPropertyIds} dataAttr="vendor-finances-filter-property" />
              </FilterCollapsibleSection>
              <FilterCollapsibleSection sectionId="from" label="From" summary={from || "Any"} empty={!from} menuOptionCount={1}>
                <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} data-attr="vendor-finances-filter-from" />
              </FilterCollapsibleSection>
              <FilterCollapsibleSection sectionId="to" label="To" summary={to || "Any"} empty={!to} menuOptionCount={1}>
                <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} data-attr="vendor-finances-filter-to" />
              </FilterCollapsibleSection>
            </FilterFieldsAccordion>
          </DemoFilterSheet>
          <PortalIconAction icon={Download} label="Export invoices CSV" data-attr="vendor-export-invoices-csv" onClick={() => show("Export invoices CSV (sample)")} />
          <PortalIconAction icon={Settings} label="Payout settings" data-attr="vendor-finances-payout-setup" onClick={() => show("Payout settings (sample)")} />
        </>
      }
      primary={{ label: "Add payment", onClick: () => setRequestOpen(true) }}
      isEmpty={rows.length === 0}
      emptyTitle={rows.length === 0 && counts[bucket] > 0 && (search.trim() || filtersActive) ? "No payments match these filters" : bucket === "paid" ? "No paid payments" : bucket === "overdue" ? "Nothing overdue" : "No payments yet"}
      emptySection="payments"
      overlay={
        <>
          {requestOpen ? (
            <DemoVendorQuoteWizard
              door="invoice"
              jobs={[...vendorServices(story ?? vendorStory(undefined)), ...EXTRA_VENDOR_SERVICES].filter((s) => s.state === "completed").map((s) => ({ id: s.id, title: s.title, place: placeLine(s) }))}
              onClose={() => setRequestOpen(false)}
              onDone={() => {
                setRequestOpen(false);
                show("Payment requested (sample)");
              }}
            />
          ) : null}
          {editRow ? (
            <DemoVendorQuoteWizard door="invoice" jobs={[{ id: editRow.id, title: editRow.title, place: editRow.place }]} initialJobId={editRow.id} onClose={() => setEditRow(null)} onDone={() => { setEditRow(null); show("Invoice updated (sample)"); }} />
          ) : null}
          {refundFor ? <DemoVendorRefundDialog initialPaymentId={refundFor} onClose={() => setRefundFor(null)} onDone={() => { setRefundFor(null); show("Refund started (sample)"); }} /> : null}
          {toastNode}
        </>
      }
    >
      {rows.map((r) => {
        const paid = r.bucket === "paid";
        const items: VendorRowMenuItem[] = [
          { id: "view", label: paid ? "View payment" : "View invoice", onSelect: () => setRecord({ kind: paid ? "payment" : "invoice", row: r }) },
          ...(r.status === "Submitted"
            ? [
                { id: "edit", label: "Edit", onSelect: () => setEditRow(r) },
                { id: "withdraw", label: "Retract invoice", onSelect: () => { setRetracted((cur) => [...cur, r.id]); show("Invoice retracted (sample)"); } },
              ]
            : []),
          ...(paid ? [{ id: "download", label: "Download", onSelect: () => show("Download (sample)") }] : []),
          ...(paid && refundable(r) ? [{ id: "refund", label: "Refund", onSelect: () => setRefundFor(r.payoutId!) }] : []),
        ];
        return (
          <PortalPropertyRecordRow
            key={r.id}
            title={r.title}
            address={r.place}
            facts={
              <>
                <PortalRowFact icon={UserRound} srLabel="Manager">{r.manager}</PortalRowFact>
                <PortalRowFact icon={CalendarDays} srLabel={paid ? "Paid" : "Due"} tone={r.bucket === "overdue" ? "danger" : undefined}>
                  {paid ? `Paid ${r.date}` : r.due ? `Due ${r.due}` : r.date}
                </PortalRowFact>
                {!paid ? <span>{r.status}</span> : null}
              </>
            }
            leading={
              <span className="flex size-14 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                <DollarSign className="size-5" />
              </span>
            }
            leadingShape="square"
            amount={r.amount}
            amountTone={r.bucket === "overdue" ? "bad" : undefined}
            actions={<VendorRowMenu label={r.title} items={items} dataAttr="vendor-payment-row-menu" />}
            onOpen={() => setRecord({ kind: paid ? "payment" : "invoice", row: r })}
            dataAttr={paid ? "vendor-income-row" : "vendor-invoice-row"}
          />
        );
      })}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Balance & payouts ───────────────────────────── */

type PayoutRow = Omit<VendorPayoutFixture, "status"> & { status: "Paid" | "In transit" | "Failed" };
/** A failed payout, so the row's ⋯ "Retry" (offered on failed rows only) is reachable. */
const FAILED_PAYOUT: PayoutRow = { id: "payout-0", kind: "Standard payout", bank: `Bank ····${DEMO_BANK.last4}`, date: "Aug 12, 2025", status: "Failed", amount: "$60.00" };

/**
 * `vendor-finances-balance.tsx`, Balance & payouts (where bare `/vendor/financials` lands): a stat strip (Available ·
 * Pending · Held · On the way) with the Bank and Withdraw icon actions, one "Payouts" destination, and the payout rows.
 * Every figure but the released balance is read off the rows; the faucet job's payout appears once it is paid.
 */
export function VendorFinancesPanel({ story }: { story?: DemoStory } = {}) {
  const current = story ?? vendorStory(undefined);
  const payments = vendorPayments(current);
  const payouts: PayoutRow[] = useMemo(
    () => [
      ...(current.service === "paid" ? [{ id: "payout-faucet", kind: "Standard payout" as const, bank: `Bank ····${DEMO_BANK.last4}`, date: "Oct 2, 2025", status: "In transit" as const, amount: "$180.00" }] : []),
      ...VENDOR_PAYOUTS,
      FAILED_PAYOUT,
    ],
    [current.service],
  );
  const [bankOpen, setBankOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState<{ amountCents?: number } | null>(null);
  const [record, setRecord] = useState<PayoutRow | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const pending = payments.filter((p) => p.status === "Submitted").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const onTheWay = payouts.filter((p) => p.status === "In transit").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const stats: PortalStat[] = [
    { id: "available", label: "Available", value: cents(DEMO_AVAILABLE_CENTS), dataAttr: "vendor-balance-available" },
    { id: "pending", label: "Pending", value: money(pending), dataAttr: "vendor-balance-pending" },
    { id: "held", label: "Held", value: money(0), dataAttr: "vendor-balance-held" },
    { id: "on-the-way", label: "On the way", value: money(onTheWay), dataAttr: "vendor-balance-on-the-way" },
  ];

  if (record) {
    const amountCents = Math.round(parseMoney(record.amount) * 100);
    return (
      <PageFrame path={`/vendor/financials/balance/${record.id}`} overlay={toastNode}>
        <DemoVendorWithdrawalRecord
          withdrawal={{
            id: record.id,
            title: record.kind === "Instant payout" ? "Instant payout" : "Standard payout",
            amountCents,
            feeCents: record.fee ? Math.round(parseMoney(record.fee.replace(/^Fee\s*/, "")) * 100) : 0,
            bank: record.bank,
            sent: record.date,
            arrived: record.date,
            status: record.status === "In transit" ? "In transit" : record.status,
          }}
          onBack={() => setRecord(null)}
          onToast={show}
        />
      </PageFrame>
    );
  }

  return (
    <FixtureListScreen
      path="/vendor/financials/balance"
      title="Finances"
      tabs={[{ id: "payouts", label: "Payouts", count: payouts.length }]}
      activeId="payouts"
      onTab={() => undefined}
      tabAriaLabel="Payout history"
      above={
        <div className="mb-3 flex items-start gap-3" data-attr="vendor-balance-card">
          <PortalStatStrip className="min-w-0 flex-1" dataAttr="vendor-balance-stats" items={stats} size="lg" />
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            <PortalIconAction icon={Landmark} label="Bank" data-attr="vendor-balance-bank" onClick={() => setBankOpen(true)} />
            <PortalIconAction icon={ArrowUpFromLine} label="Withdraw" data-attr="vendor-balance-withdraw" onClick={() => setWithdrawOpen({})} />
          </div>
        </div>
      }
      isEmpty={payouts.length === 0}
      emptyTitle="No payouts yet"
      emptySection="financials"
      overlay={
        <>
          {bankOpen ? (
            <DemoVendorAddBankDialog
              onClose={() => setBankOpen(false)}
              onDone={() => {
                setBankOpen(false);
                show("Bank account added (sample)");
              }}
            />
          ) : null}
          {withdrawOpen ? (
            <DemoVendorWithdrawDialog
              initialAmountCents={withdrawOpen.amountCents}
              onClose={() => setWithdrawOpen(null)}
              onDone={() => {
                setWithdrawOpen(null);
                show("Withdrawal started (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {payouts.map((p) => (
        <PortalPropertyRecordRow
          key={p.id}
          title={p.kind}
          address={p.bank}
          leading={
            <span className="grid size-14 place-items-center rounded-xl bg-accent/60 text-muted" aria-hidden>
              {p.kind === "Instant payout" ? <Zap className="size-5" strokeWidth={1.75} /> : <ArrowUp className="size-5" strokeWidth={1.75} />}
            </span>
          }
          leadingShape="square"
          facts={
            <>
              <PortalRowFact icon={CalendarDays} srLabel="Sent">{p.date}</PortalRowFact>
              <span>{p.status}</span>
              {p.fee ? <PortalRowFact icon={Zap} srLabel="Fee">{p.fee}</PortalRowFact> : null}
            </>
          }
          amount={p.amount}
          amountTone={p.status === "Failed" ? "bad" : undefined}
          actions={
            p.status === "Failed" ? (
              <VendorRowMenu label={p.kind} dataAttr="vendor-payout-row-menu" items={[{ id: "retry", label: "Retry", onSelect: () => setWithdrawOpen({ amountCents: Math.round(parseMoney(p.amount) * 100) }) }]} />
            ) : undefined
          }
          onOpen={() => setRecord(p)}
          dataAttr="vendor-payout-history-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Outgoing payments ───────────────────────────── */

const VENDOR_EXPENSES = [
  { id: "exp-1", title: "Faucet cartridge and supply line", category: "Materials", date: "Oct 1, 2025", amount: "$42.18" },
  { id: "exp-2", title: "Pipe wrench", category: "Tools", date: "Sep 29, 2025", amount: "$36.50" },
  { id: "exp-3", title: "Fuel", category: "Fuel", date: "Sep 24, 2025", amount: "$58.40" },
] as const;

export function VendorOutgoingPanel() {
  const [search, setSearch] = useState("");
  const { show, node: toastNode } = useFixtureToast();
  const rows = VENDOR_EXPENSES.filter((e) => matchesSearch(search, e.title, e.category));
  return (
    <FixtureListScreen
      path="/vendor/outgoing/this-month"
      title="Outgoing payments"
      tabs={[
        { id: "this-month", label: "This month", count: VENDOR_EXPENSES.length },
        { id: "last-month", label: "Last month" },
        { id: "earlier", label: "Earlier" },
      ]}
      activeId="this-month"
      onTab={() => undefined}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search expenses"
      actions={
        <>
          <PortalIconAction icon={Download} label="Download expenses" onClick={() => show("Download (sample)")} />
        </>
      }
      primary={{ label: "Add expense", onClick: () => show("Add expense") }}
      isEmpty={rows.length === 0}
      emptyTitle="No expenses yet"
      emptySection="payments"
      overlay={toastNode}
    >
      {rows.map((e) => (
        <PortalPropertyRecordRow
          key={e.id}
          title={e.title}
          address={e.category}
          facts={<span className="truncate">{e.date}</span>}
          amount={e.amount}
          actions={
            <VendorRowMenu
              label={e.title}
              dataAttr="vendor-expense-row-menu"
              items={[
                { id: "edit", label: "Edit", onSelect: () => show("Edit (sample)") },
                { id: "delete", label: "Delete", destructive: true, onSelect: () => show("Delete (sample)") },
              ] satisfies VendorRowMenuItem[]}
            />
          }
          onOpen={() => show("Expense (sample)")}
          dataAttr="vendor-expense-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Refunds ───────────────────────────── */

const REFUND_STATUS = {
  pending: { icon: Clock, text: "Pending" },
  succeeded: { icon: Check, text: "Refunded" },
  failed: { icon: AlertTriangle, text: "Failed" },
} as const;

/**
 * `vendor-refunds-panel.tsx`: no tabs; the refund rows (tile, payment, manager, date, status as glyph facts, figure, ⋯
 * "Refresh status") and the round "Refund a payment". The real list surface carries that action as `add`, which a
 * populated surface does not draw, so the demo puts it in the page's command bar where every other round + lives.
 */
export function VendorRefundsPanel() {
  const { show, node: toastNode } = useFixtureToast();
  const [open, setOpen] = useState(false);
  return (
    <FixtureListScreen
      path="/vendor/financials/refunds"
      title="Finances"
      tabs={[]}
      activeId=""
      onTab={() => undefined}
      primary={{ label: "Refund a payment", onClick: () => setOpen(true) }}
      isEmpty={DEMO_REFUNDS.length === 0}
      emptyTitle="No refunds yet"
      emptySection="payments"
      overlay={
        <>
          {open ? (
            <DemoVendorRefundDialog
              onClose={() => setOpen(false)}
              onDone={() => {
                setOpen(false);
                show("Refund started (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {DEMO_REFUNDS.map((refund) => {
        const status = REFUND_STATUS[refund.status];
        return (
          <PortalPropertyRecordRow
            key={refund.id}
            title={refund.paymentLabel}
            leading={<PortalRowIconTile icon={Undo2} />}
            leadingShape="square"
            facts={
              <>
                <PortalRowFact icon={UserRound} srLabel="Manager">{refund.manager}</PortalRowFact>
                <PortalRowFact icon={CalendarDays} srLabel="Date">{refund.date}</PortalRowFact>
                <PortalRowFact icon={status.icon} srLabel="Status" tone={refund.status === "failed" ? "danger" : undefined}>{status.text}</PortalRowFact>
              </>
            }
            amount={cents(refund.grossCents)}
            dataAttr="vendor-refund-row"
            actions={<VendorRowMenu label={refund.paymentLabel} dataAttr="vendor-refund-menu" items={[{ id: "refresh", label: "Refresh status", onSelect: () => show("Status refreshed (sample)") }]} />}
          />
        );
      })}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Statements ───────────────────────────── */

export function VendorStatementsPanel() {
  const { show, node: toastNode } = useFixtureToast();
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  return (
    <FixtureListScreen
      path="/vendor/financials/statements"
      title="Finances"
      tabs={[{ id: "statements", label: "Statements", count: DEMO_STATEMENTS.length }]}
      activeId="statements"
      onTab={() => undefined}
      tabAriaLabel="Statements"
      actions={<PortalIconAction icon={Download} label="Export all activity CSV" data-attr="vendor-statements-export-all" onClick={() => show("Export all activity CSV (sample)")} />}
      isEmpty={DEMO_STATEMENTS.length === 0}
      emptyTitle="No statements yet"
      emptySection="financials"
      overlay={
        <>
          {openMonth ? <DemoVendorStatementDialog month={openMonth} onClose={() => setOpenMonth(null)} /> : null}
          {toastNode}
        </>
      }
    >
      {DEMO_STATEMENTS.map((statement) => {
        const label = statementMonthLabel(statement.month);
        return (
          <PortalPropertyRecordRow
            key={statement.month}
            title={label}
            leading={
              <span className="grid size-14 place-items-center rounded-xl bg-accent text-primary" aria-hidden>
                <FileText className="size-5" />
              </span>
            }
            leadingShape="square"
            facts={
              <>
                <span>Opening {cents(statement.openingCents)}</span>
                <span>Closing {cents(statementClosingCents(statement))}</span>
                <span>Matches Stripe</span>
                <PortalRowFact icon={FileText} srLabel="Lines">{statement.lines.length} lines</PortalRowFact>
              </>
            }
            actions={
              <VendorRowMenu
                label={label}
                dataAttr="vendor-statement-row-menu"
                items={[
                  { id: "view", label: "View statement", onSelect: () => setOpenMonth(statement.month) },
                  { id: "pdf", label: "Download PDF", onSelect: () => show("Download PDF (sample)") },
                  { id: "csv", label: "Download CSV", onSelect: () => show("Download CSV (sample)") },
                ]}
              />
            }
            onOpen={() => setOpenMonth(statement.month)}
            dataAttr="vendor-statement-month-row"
          />
        );
      })}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Finances: Tax info ───────────────────────────── */

export function VendorTaxPanel() {
  const { show, node: toastNode } = useFixtureToast();
  const [editing, setEditing] = useState(false);
  const currentYear = 2025;
  const hasW9 = true;
  return (
    <FixtureListScreen
      path="/vendor/financials/tax"
      title="Finances"
      tabs={[{ id: "years", label: "Tax years", count: DEMO_TAX_YEARS.length }]}
      activeId="years"
      onTab={() => undefined}
      tabAriaLabel="Tax years"
      above={
        <PortalSettingsSection title="W-9" action={<PortalIconAction icon={Pencil} label={hasW9 ? "Edit W-9" : "Add W-9"} data-attr="vendor-tax-edit" onClick={() => setEditing(true)} />}>
          <PortalSettingsGroup>
            <PortalSettingsRow label="Legal name"><span data-attr="vendor-tax-legal-name">{DEMO_W9.legalName}</span></PortalSettingsRow>
            <PortalSettingsRow label="Tax ID"><span data-attr="vendor-tax-tin">{maskTin(DEMO_W9.tinType, DEMO_W9.tinLast4)}</span></PortalSettingsRow>
            <PortalSettingsRow label="Entity type">{vendorW9EntityLabel(DEMO_W9.entityType)}</PortalSettingsRow>
            <PortalSettingsRow label="Address">{[DEMO_W9.city, DEMO_W9.state].filter(Boolean).join(", ")}</PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      }
      isEmpty={DEMO_TAX_YEARS.length === 0}
      emptyTitle="No tax years yet"
      emptySection="financials"
      overlay={
        <>
          {editing ? (
            <DemoVendorW9Dialog
              hasW9={hasW9}
              onClose={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                show("W-9 saved (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {DEMO_TAX_YEARS.map((year) => {
        const reportable = Math.max(0, year.earningsCents - year.refundsCents);
        const summary: VendorTaxYearSummary = { year: year.year, earningsCents: year.earningsCents, feesCents: year.feesCents, refundsCents: year.refundsCents, reportableCents: reportable, thresholdCents: year.thresholdCents, overThreshold: reportable >= year.thresholdCents };
        return (
          <PortalPropertyRecordRow
            key={year.year}
            title={String(year.year)}
            leading={
              <span className="grid size-14 place-items-center rounded-xl bg-accent text-sm font-semibold text-primary" aria-hidden>
                {year.year}
              </span>
            }
            leadingShape="square"
            facts={
              <>
                <span>Earnings {cents(year.earningsCents)}</span>
                <span>Fees {cents(year.feesCents)}</span>
                <span>Refunds {cents(year.refundsCents)}</span>
                <span data-attr="vendor-tax-1099-status">{form1099StatusLabel(summary, { hasW9, currentYear })}</span>
              </>
            }
            dataAttr="vendor-tax-year-row"
          />
        );
      })}
    </FixtureListScreen>
  );
}

/** The Finances section the sidebar's sub-row names: overview and balance (also bare) or refunds. Payments, Statements and Tax live in their own sections now. */
export function VendorFinancesRouter({ story, sub }: { story?: DemoStory; sub?: string }) {
  if (sub === "refunds") return <VendorRefundsPanel />;
  return <VendorFinancesPanel story={story} />;
}

/* ───────────────────────────── Dashboard: Balance card ───────────────────────────── */

/**
 * `VendorDashboardBalanceCard` (the dashboard's `belowKpis` slot): "Available to withdraw", the on-the-way and pending
 * lines, and the Withdraw icon (Add bank account when no bank is set up). Presentational, fed the same rows the
 * Balance & payouts tab reads.
 */
export function VendorDashboardBalanceDemo({ story }: { story?: DemoStory } = {}) {
  const current = story ?? vendorStory(undefined);
  const payments = vendorPayments(current);
  const pending = payments.filter((p) => p.status === "Submitted").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const onTheWay = current.service === "paid" ? 180 : 0;
  const { show, node: toastNode } = useFixtureToast();
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-border bg-card px-4 py-3.5" data-attr="vendor-dashboard-balance">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-[550] text-muted">Available to withdraw</p>
          <p className="my-1 text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] text-foreground" data-attr="vendor-dashboard-balance-available">
            {cents(DEMO_AVAILABLE_CENTS)}
          </p>
          {onTheWay > 0 ? <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-balance-pending">{money(onTheWay)} on the way to your bank</p> : null}
          {pending > 0 ? <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-payment-pending">{money(pending)} pending payment</p> : null}
        </div>
        <PortalIconAction icon={ArrowUpFromLine} label="Withdraw" data-attr="vendor-dashboard-withdraw" onClick={() => setWithdrawOpen(true)} />
      </div>
      {withdrawOpen ? (
        <DemoVendorWithdrawDialog
          onClose={() => setWithdrawOpen(false)}
          onDone={() => {
            setWithdrawOpen(false);
            show("Withdrawal started (sample)");
          }}
        />
      ) : null}
      {toastNode}
    </div>
  );
}

/* ───────────────────────────── Reviews ───────────────────────────── */

/** The Filter popover's Rating list (`RATING_FILTER_OPTIONS`). */
const RATING_FILTER_OPTIONS = [
  { value: "0", label: "All ratings" },
  { value: "5", label: "5 stars" },
  { value: "4", label: "4 stars & up" },
  { value: "3", label: "3 stars & up" },
  { value: "2", label: "2 stars & up" },
  { value: "1", label: "1 star & up" },
];

function reviewDate(at: string): string {
  const parts = at.split(",");
  return parts.length >= 2 ? `${parts[0]!.trim()}, ${parts[1]!.trim()}` : at;
}

export function VendorReviewsPanel() {
  const [search, setSearch] = useState("");
  const [rating, setRating] = useState("0");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<{ review: VendorReviewFixture; quick: boolean } | null>(null);
  const { show, node: toastNode } = useFixtureToast();

  // A reply typed here lives in this panel only; the row then reads as replied.
  // One list, newest first: no tabs, no stat cards. The header line is derived from these same rows.
  const reviews = useMemo(
    () =>
      VENDOR_REVIEWS.map((r) => (replies[r.id] ? { ...r, reply: replies[r.id] } : r)).sort((a, b) => (isoOf(reviewDate(b.at)) < isoOf(reviewDate(a.at)) ? -1 : 1)),
    [replies],
  );
  const minStars = rating === "0" ? null : Number(rating);
  const rows = reviews.filter((r) => {
    if (minStars != null && r.stars < minStars) return false;
    const iso = isoOf(reviewDate(r.at));
    if (fromDate && iso < fromDate) return false;
    if (toDate && iso > toDate) return false;
    return matchesSearch(search, r.body, r.reply);
  });
  const filtersActive = portalFilterActiveCount([rating !== "0" ? rating : "", fromDate, toDate]);

  return (
    <FixtureListScreen
      path="/vendor/reviews"
      title="Reviews"
      tabs={[]}
      activeId=""
      onTab={() => undefined}
      recordSummary={reviewsSummary(reviews.map((r) => ({ stars: r.stars })) as unknown as Parameters<typeof reviewsSummary>[0])}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search reviews"
      actions={
        <>
          <DemoFilterSheet
            activeCount={filtersActive}
            compactPanel
            filterFieldCount={3}
            commandStripTrigger
            onReset={() => {
              setRating("0");
              setFromDate("");
              setToDate("");
            }}
            dataAttr="vendor-reviews-filter-open"
          >
            <FilterFieldsAccordion>
              <FilterCollapsibleSection sectionId="rating" label="Rating" summary={filterSingleSelectSummary(rating, RATING_FILTER_OPTIONS, "All ratings")} empty={rating === "0"} menuOptionCount={RATING_FILTER_OPTIONS.length} dataAttr="vendor-reviews-filter-rating">
                <FilterSingleSelectList options={RATING_FILTER_OPTIONS} value={rating} onChange={setRating} dataAttr="vendor-reviews-rating" />
              </FilterCollapsibleSection>
              <FilterCollapsibleSection sectionId="from" label="From" summary={fromDate || "Any"} empty={!fromDate} menuOptionCount={1}>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} data-attr="vendor-reviews-filter-from" />
              </FilterCollapsibleSection>
              <FilterCollapsibleSection sectionId="to" label="To" summary={toDate || "Any"} empty={!toDate} menuOptionCount={1}>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} data-attr="vendor-reviews-filter-to" />
              </FilterCollapsibleSection>
            </FilterFieldsAccordion>
          </DemoFilterSheet>
          <PortalIconAction icon={Settings} label="Profile settings" data-attr="vendor-reviews-settings-gear" onClick={() => show("Profile settings (sample)")} />
        </>
      }
      isEmpty={rows.length === 0}
      emptyTitle={reviews.length === 0 ? "No reviews yet" : "No reviews match these filters"}
      emptySection="reviews"
      overlay={
        <>
          {replying ? (
            <DemoVendorReplyDialog
              key={`${replying.review.id}-${replying.quick}`}
              stars={replying.review.stars}
              body={replying.review.body}
              reply={replying.review.reply}
              openQuickReplies={replying.quick}
              onClose={() => setReplying(null)}
              onSaved={(text) => {
                setReplies((m) => ({ ...m, [replying.review.id]: text.trim() }));
                setReplying(null);
                show(replying.review.reply ? "Reply updated (sample)" : "Reply sent (sample)");
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {rows.map((review) => {
        const replied = Boolean(review.reply);
        return (
          <PortalPropertyRecordRow
            key={review.id}
            title="A PropLane manager"
            address={review.body}
            facts={
              <>
                <PortalRowFact icon={CalendarDays} srLabel="Reviewed">{reviewDate(review.at)}</PortalRowFact>
                {replied ? <PortalRowFact icon={Check} srLabel="Replied">Replied</PortalRowFact> : null}
              </>
            }
            leading={
              <span className="flex size-14 items-center justify-center rounded-xl bg-accent text-[15px] font-bold text-primary" aria-hidden>
                {Math.round(review.stars)}{"★"}
              </span>
            }
            leadingShape="square"
            onOpen={() => setReplying({ review, quick: false })}
            dataAttr="vendor-review-row"
            actions={
              <VendorRowMenu
                label="A PropLane manager"
                dataAttr="vendor-review-menu"
                items={
                  replied
                    ? [{ id: "edit-reply", label: "Edit reply", onSelect: () => setReplying({ review, quick: false }) }]
                    : [
                        { id: "reply", label: "Reply", onSelect: () => setReplying({ review, quick: false }) },
                        { id: "reply-quick", label: "Reply with a quick reply", onSelect: () => setReplying({ review, quick: true }) },
                      ]
                }
              />
            }
          />
        );
      })}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

/** The record kind a conversation is about, when it is about one (an invoice thread carries its INV number). */
function conversationKind(c: CommConversationFixture): RecordKind | null {
  if (/INV-/.test(c.subtitle)) return "outgoing-payment";
  return /change order|faucet|valve|disposal/i.test(c.preview) ? "service" : null;
}

/**
 * `vendor-communication.tsx`: Active · Archived, the pinned PropLane assistant row, the list's Filter (Status and About),
 * the Communication settings gear (a Settings page in the real portal) and the round New message, which opens the
 * real compose dialog; search says "Search communication".
 */
export function VendorCommunicationPanel({ conversations }: { conversations: CommConversationFixture[] }) {
  const [segment, setSegment] = useState<"active" | "archived">("active");
  const [status, setStatus] = useState<CommunicationStatus>("active");
  const [about, setAbout] = useState("");
  const [selectedId, setSelectedId] = useState(conversations.find((c) => c.segment === "active")?.id ?? conversations[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, { id: string; author: string; body: string; at: string; direction: "outbound" }[]>>({});
  const { show, node: toastNode } = useFixtureToast();
  // The list and thread sit side by side from the desktop breakpoint; below it the real inbox shows the list until a row is opened.
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
    for (const conv of conversations) c[conv.segment] += 1;
    return c;
  }, [conversations]);
  const visible = conversations.filter(
    (c) =>
      c.segment === segment &&
      (status === "unread" ? c.unread : status === "read" ? !c.unread : true) &&
      (!about || conversationKind(c) === about) &&
      matchesSearch(query, c.name, c.subtitle, c.preview),
  );
  const assistantSelected = selectedId === "propLane-assistant";
  const selected: CommConversationFixture | undefined = assistantSelected ? undefined : (conversations.find((c) => c.id === selectedId) ?? visible[0]);
  const messages = selected ? [...selected.messages, ...(sent[selected.id] ?? [])] : [];
  const filterCount = (status === "active" ? 0 : 1) + (about ? 1 : 0);

  function send() {
    if (!draft.trim() || !selected) return;
    setSent((m) => ({
      ...m,
      [selected.id]: [...(m[selected.id] ?? []), { id: `local-${(m[selected.id]?.length ?? 0) + 1}`, author: VENDOR_NAME, body: draft, at: "Just now", direction: "outbound" }],
    }));
    setDraft("");
    show("Sent");
  }

  return (
    <ProductWindow path="/vendor/communication/active">
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Communication" viewportFillBody>
          <InboxTwoPane
            threadOpen={wide || opened}
            fillParent
            panes="split"
            list={
              <div className="flex h-full flex-col">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <LocalDestinationNav
                    appearance="command"
                    ariaLabel="Conversations"
                    items={[
                      { id: "active", label: "Active", count: counts.active },
                      { id: "archived", label: "Archived", count: counts.archived },
                    ]}
                    activeId={segment}
                    onChange={(id) => setSegment(id as "active" | "archived")}
                  />
                  <span className="flex shrink-0 items-center">
                    <DemoFilterSheet activeCount={filterCount} compactPanel filterFieldCount={2} commandStripTrigger onReset={() => { setStatus("active"); setAbout(""); }} dataAttr="vendor-communication-filter-open">
                      <CommunicationStatusFilterDraft value={status} onChange={setStatus} hideArchived />
                      <FieldSingleSelect
                        label="About"
                        value={about}
                        onChange={setAbout}
                        options={[{ value: "", label: "All records" }, ...RECORD_KIND_FILTER_OPTIONS]}
                        placeholder="All records"
                        dataAttr="vendor-communication-filter-about"
                      />
                    </DemoFilterSheet>
                    <PortalIconAction icon={Settings} label="Communication settings" data-attr="vendor-communication-settings-gear" onClick={() => show("Communication settings (sample)")} />
                    <PortalPrimaryIconAction label="New message" icon={PenSquare} data-attr="communication-new-message" onClick={() => setComposeOpen(true)} />
                  </span>
                </div>
                <div className="border-b border-border px-3 py-1.5">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search communication"
                    aria-label="Search messages"
                    className="h-8 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {!query.trim() || "proplane".includes(query.trim().toLowerCase()) ? (
                    <div data-attr="vendor-communication-assistant-row">
                      <InboxConversationRow
                        appearance="flat"
                        name="PropLane"
                        subtitle="PropLane"
                        preview="Ask about your services, quotes or payments"
                        time=""
                        unread={false}
                        selected={assistantSelected}
                        onOpen={() => {
                          setSelectedId("propLane-assistant");
                          setOpened(true);
                        }}
                      />
                    </div>
                  ) : null}
                  {visible.map((c) => (
                    <InboxConversationRow
                      key={c.id}
                      appearance="flat"
                      name={c.name}
                      subtitle={c.subtitle}
                      preview={c.preview}
                      time={c.time}
                      unread={c.unread}
                      selected={c.id === selected?.id}
                      onOpen={() => {
                        setSelectedId(c.id);
                        setOpened(true);
                      }}
                    />
                  ))}
                </div>
              </div>
            }
            thread={
              assistantSelected ? (
                <InboxThreadView
                  title="PropLane"
                  subtitle="PropLane"
                  avatarName="PropLane"
                  messages={[{ id: "assistant-1", author: "PropLane", body: "Ask about your services, quotes or payments.", at: "Now", direction: "inbound" }]}
                  onBack={() => setOpened(false)}
                  composer={<InboxComposer value={draft} onChange={setDraft} onSubmit={() => { setDraft(""); show("Sent"); }} placeholder="Write a message…" dataAttr="demo-panel-composer" />}
                />
              ) : selected ? (
                <InboxThreadView
                  title={selected.name}
                  subtitle={selected.subtitle}
                  avatarName={selected.name}
                  messages={messages}
                  onBack={() => setOpened(false)}
                  composer={<InboxComposer value={draft} onChange={setDraft} onSubmit={send} placeholder="Write a message…" dataAttr="demo-panel-composer" />}
                />
              ) : null
            }
          />
        </ManagerPortalPageShell>
      </div>
      {composeOpen ? (
        <DemoVendorComposeDialog
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false);
            show("Message sent (sample)");
          }}
        />
      ) : null}
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Documents ───────────────────────────── */

/** Which checklist row (`fixtures-more.ts`) backs each real document kind; the two new kinds have no file yet. */
const CHECKLIST_OF_KIND: Partial<Record<VendorDocumentKind, string>> = {
  w9: "vdoc-w9",
  income_tax_return: "vdoc-return",
  ein_letter: "vdoc-ein",
  license: "vdoc-license",
  bond: "vdoc-bond",
  insurance: "vdoc-coi",
  workers_comp: "vdoc-wc",
};

type OwnDocument = { fileName: string; uploaded: string };
type DocumentSource = "all" | "mine" | "managers";

const SOURCE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "managers", label: "From managers" },
];

/** `VendorDocumentRowOverflow`: View (added with `onOpen`) · Download · Replace/Upload · Delete in the row's one ⋯. */
function DocumentRowOverflow({ label, hasDoc, onReplace, onDownload, onDelete, children }: { label: string; hasDoc: boolean; onReplace: () => void; onDownload?: () => void; onDelete?: () => void; children: ReactNode }) {
  return (
    <RecordActionContext.Provider
      value={{
        scope: label,
        clear: () => {},
        actions: (
          <>
            {onDownload ? <Button type="button" variant="outline" data-attr="vendor-document-download" data-record-action-id="download" onClick={onDownload}>Download</Button> : null}
            <Button type="button" variant="outline" data-attr="vendor-document-replace" data-record-action-id="edit" onClick={onReplace}>{hasDoc ? "Replace" : "Upload"}</Button>
            {onDelete ? <Button type="button" variant="danger" data-attr="vendor-document-delete" data-record-action-id="delete" onClick={onDelete}>Delete</Button> : null}
          </>
        ),
      }}
    >
      {children}
    </RecordActionContext.Provider>
  );
}

/**
 * `vendor-documents-panel.tsx`: no tabs; rows grouped by Tax · Business license · Insurance over the nine document
 * kinds, each section header the name with "N of M" uploaded, then the documents managers shared. Filter has Source
 * and Section; the round + is "Add document" (Upload document); an uploaded row toggles the inline viewer, a missing
 * one opens the file picker; the row ⋯ is View, Download, Replace / Upload, Delete.
 */
export function VendorDocumentsPanel() {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<DocumentSource>("all");
  const [category, setCategory] = useState("");
  const [uploadOpen, setUploadOpen] = useState<VendorDocumentKind | null | "new">(null);
  const [previewKind, setPreviewKind] = useState<VendorDocumentKind | null>(null);
  const [sharedPreview, setSharedPreview] = useState<string | null>(null);
  const [docs, setDocs] = useState<Partial<Record<VendorDocumentKind, OwnDocument>>>(() => {
    const out: Partial<Record<VendorDocumentKind, OwnDocument>> = {};
    for (const [kind, id] of Object.entries(CHECKLIST_OF_KIND)) {
      const item = VENDOR_CHECKLIST.find((i) => i.id === id);
      if (item?.file) out[kind as VendorDocumentKind] = { fileName: item.file, uploaded: (item.uploaded ?? "").replace(/^Uploaded\s*/, "") };
    }
    return out;
  });
  const { show, node: toastNode } = useFixtureToast();

  const includesMine = source !== "managers";
  const includesManagers = source !== "mine";
  const sectionOptions = [{ value: "", label: "All sections" }, ...VENDOR_DOCUMENT_SECTIONS.map((s) => ({ value: s.id, label: s.label }))];
  const sections = VENDOR_DOCUMENT_SECTIONS.filter((s) => !category || s.id === category).map((section) => {
    const all = section.kinds;
    const shown = includesMine ? all.filter((kind) => matchesSearch(search, VENDOR_DOCUMENT_LABELS[kind], docs[kind]?.fileName, section.label)) : [];
    return { section, shown, uploaded: all.filter((kind) => docs[kind]).length, total: all.length };
  });
  const sharedRows = includesManagers && !category ? DEMO_MANAGER_DOCUMENTS.filter((d) => matchesSearch(search, d.name, d.category)) : [];
  const visibleCount = sections.reduce((n, s) => n + s.shown.length, 0) + sharedRows.length;
  const filtersActive = portalFilterActiveCount([source !== "all" ? source : "", category]);
  const nextMissing = (VENDOR_DOCUMENT_SECTIONS.flatMap((s) => s.kinds) as VendorDocumentKind[]).find((kind) => !docs[kind] && isVendorComplianceDocumentKind(kind));

  return (
    <FixtureListScreen
      path="/vendor/documents"
      title="Documents"
      tabs={[]}
      activeId=""
      onTab={() => undefined}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search documents"
      actions={
        <DemoFilterSheet
          activeCount={filtersActive}
          compactPanel
          filterFieldCount={2}
          commandStripTrigger
          onReset={() => {
            setSource("all");
            setCategory("");
          }}
          dataAttr="vendor-documents-filter-open"
        >
          <FilterFieldsAccordion>
            <FilterCollapsibleSection sectionId="source" label="Source" summary={filterSingleSelectSummary(source, SOURCE_OPTIONS, "All")} empty={source === "all"} menuOptionCount={SOURCE_OPTIONS.length} dataAttr="vendor-documents-filter-source">
              <FilterSingleSelectList options={SOURCE_OPTIONS} value={source} onChange={(next) => setSource(next as DocumentSource)} dataAttr="vendor-documents-source" />
            </FilterCollapsibleSection>
            <FilterCollapsibleSection sectionId="section" label="Section" summary={filterSingleSelectSummary(category, sectionOptions, "All sections")} empty={!category} menuOptionCount={sectionOptions.length} dataAttr="vendor-documents-filter-section">
              <FilterSingleSelectList options={sectionOptions} value={category} onChange={setCategory} dataAttr="vendor-documents-section" />
            </FilterCollapsibleSection>
          </FilterFieldsAccordion>
        </DemoFilterSheet>
      }
      primary={includesMine ? { label: "Add document", onClick: () => setUploadOpen(nextMissing ?? "new") } : undefined}
      isEmpty={visibleCount === 0}
      emptyTitle={search.trim() ? "No documents match this search" : "No documents yet"}
      emptySection="documents"
      overlay={
        <>
          {uploadOpen ? (
            <DemoVendorUploadDocumentPopup
              initialKind={uploadOpen === "new" ? undefined : uploadOpen}
              onClose={() => setUploadOpen(null)}
              onDone={(kind) => {
                setDocs((cur) => ({ ...cur, [kind]: { fileName: `${VENDOR_DOCUMENT_LABELS[kind].toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`, uploaded: "Oct 8, 2025" } }));
                setUploadOpen(null);
                show(`${VENDOR_DOCUMENT_LABELS[kind]} uploaded (sample)`);
              }}
            />
          ) : null}
          {toastNode}
        </>
      }
    >
      {sections
        .filter((s) => s.shown.length > 0)
        .map(({ section, shown, uploaded, total }) => (
          <div key={section.id} data-attr="vendor-documents-section" className="vdoc-section">
            <div className="flex items-baseline justify-between px-1 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
              <span>{section.label}</span>
              <span className="text-[12.5px] font-semibold normal-case tracking-normal">
                {uploaded} of {total}
              </span>
            </div>
            {shown.map((kind) => {
              const doc = docs[kind];
              const complianceMissing = !doc && isVendorComplianceDocumentKind(kind);
              return (
                <DocumentRowOverflow
                  key={kind}
                  label={VENDOR_DOCUMENT_LABELS[kind]}
                  hasDoc={Boolean(doc)}
                  onReplace={() => setUploadOpen(kind)}
                  onDownload={doc ? () => show("Download (sample)") : undefined}
                  onDelete={
                    doc
                      ? () => {
                          setDocs((cur) => {
                            const next = { ...cur };
                            delete next[kind];
                            return next;
                          });
                          if (previewKind === kind) setPreviewKind(null);
                          show("Document removed (sample)");
                        }
                      : undefined
                  }
                >
                  <PortalPropertyRecordRow
                    title={VENDOR_DOCUMENT_LABELS[kind]}
                    attention={complianceMissing}
                    address={doc?.fileName}
                    leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
                    facts={
                      doc ? (
                        <PortalRowFact icon={Check} srLabel="Uploaded">{`Uploaded ${doc.uploaded}`}</PortalRowFact>
                      ) : complianceMissing ? (
                        <PortalRowFact icon={AlertTriangle} srLabel="Required">Required</PortalRowFact>
                      ) : (
                        <PortalRowFact icon={Clock} srLabel="Not uploaded">Not uploaded</PortalRowFact>
                      )
                    }
                    omitActionView={!doc}
                    checked={false}
                    onSelectedChange={() => undefined}
                    onOpen={doc ? () => setPreviewKind((cur) => (cur === kind ? null : kind)) : () => show("Choose a PDF to upload (sample)")}
                    dataAttr="vendor-document-row"
                  />
                </DocumentRowOverflow>
              );
            })}
          </div>
        ))}
      {sharedRows.map((doc) => (
        <PortalPropertyRecordRow
          key={doc.id}
          title={doc.name}
          address={doc.category}
          leading={<FileText className="size-5 text-foreground" strokeWidth={1.8} aria-hidden />}
          facts={doc.date}
          selected={sharedPreview === doc.id}
          onOpen={() => setSharedPreview((cur) => (cur === doc.id ? null : doc.id))}
          dataAttr="vendor-document-row"
        />
      ))}
      {previewKind ? <DemoVendorDocumentViewer title={VENDOR_DOCUMENT_LABELS[previewKind]} onDownload={() => show("Download (sample)")} /> : null}
      {sharedPreview ? <DemoVendorDocumentViewer title={DEMO_MANAGER_DOCUMENTS.find((d) => d.id === sharedPreview)?.name ?? "Document"} downloadLabel="Download" onDownload={() => show("Download (sample)")} /> : null}
    </FixtureListScreen>
  );
}
