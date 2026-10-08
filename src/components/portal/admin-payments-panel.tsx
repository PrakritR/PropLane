"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Banknote,
  CalendarDays,
  CreditCard,
  Download,
  ExternalLink,
  Landmark,
  Receipt,
  Smartphone,
  Undo2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { FilterFieldsAccordion } from "@/components/portal/filter-field-lists";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordActions, PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { RecordFactCard, RecordFactRow, StatTile } from "@/components/portal/portal-record-overview-kit";
import {
  AdminListPager,
  AdminMonthSwitcher,
  AdminSingleSelectFilterField,
  AdminTestModeBanner,
} from "@/components/portal/admin-money-ui";
import { Button } from "@/components/ui/button";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDate, pacificCalendarMonthKey } from "@/lib/pacific-time";
import { adminAccountKey } from "@/lib/admin/admin-account-keys";
import {
  formatAdminUsd,
  isRevenueMonth,
  revenueCategoryLabel,
  REVENUE_TABS,
  revenueTabFromParam,
  shiftMonth,
  stripeDashboardUrl,
  type RevenueCategory,
  type RevenueRow,
  type RevenueRowSource,
  type RevenueSummary,
  type RevenueTabId,
} from "@/lib/admin/admin-revenue-model";
import type { AdminRevenuePage } from "@/lib/admin/admin-revenue.server";

const FETCH_TIMEOUT_MS = 25_000;
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

type SourceFilter = "all" | RevenueRowSource;

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "stripe", label: "Stripe" },
  { value: "app_store", label: "App Store" },
  { value: "ledger", label: "Service fee ledger" },
];

const CATEGORY_ICON: Record<RevenueCategory, LucideIcon> = {
  subscriptions: CreditCard,
  credits: Receipt,
  numbers: Smartphone,
  service_fees: Banknote,
  payouts: Landmark,
  refunds: Undo2,
  other: CreditCard,
};

type PaymentsState =
  | { status: "loading" }
  | { status: "ready"; data: AdminRevenuePage }
  | { status: "error"; message: string; code: string | null };

/** The Pacific calendar month, the same one the server buckets payments by. */
function currentMonthKey(): string {
  return pacificCalendarMonthKey(Date.now());
}

function dayLabel(iso: string): string {
  return formatPacificDate(iso, { month: "short", day: "numeric" });
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${formatAdminUsd(cents)}` : formatAdminUsd(cents);
}

/** The glyph facts on a row's place line (at most three). */
function rowFacts(row: RevenueRow): PortalEntryRowFact[] {
  if (row.category === "payouts") {
    const facts: PortalEntryRowFact[] = [];
    if (row.payout?.bankLast4) facts.push({ icon: Landmark, label: `Bank ****${row.payout.bankLast4}`, srLabel: "Bank" });
    if (row.payout?.arrivalDate) {
      facts.push({ icon: CalendarDays, label: `Arrives ${dayLabel(row.payout.arrivalDate)}`, srLabel: "Arrival" });
    }
    return facts;
  }
  if (row.source === "app_store") return [{ icon: Smartphone, label: "via App Store", srLabel: "Source" }];
  if (row.source === "ledger") return [{ icon: Banknote, label: "PropLane ledger", srLabel: "Source" }];
  if (row.category === "refunds" || row.category === "other") return [];
  return [
    { icon: Receipt, label: `Stripe fee ${formatAdminUsd(-row.feeCents)}`, srLabel: "Stripe fee" },
    { label: `Net ${formatAdminUsd(row.netCents)}` },
  ];
}

export function revenueRowHref(row: RevenueRow, month: string): string {
  return `/admin/payments/${encodeURIComponent(row.id)}?month=${month}`;
}

function accountHref(row: RevenueRow): string | null {
  return row.accountId ? `/admin/axis-users/${encodeURIComponent(adminAccountKey("manager", row.accountId))}` : null;
}

function openStripe(path: string, testMode: boolean) {
  window.open(stripeDashboardUrl(path, testMode), "_blank", "noopener,noreferrer");
}

export function AdminPaymentsPanel({ detailId }: { detailId?: string } = {}) {
  if (detailId) return <AdminPaymentRecord id={detailId} />;
  return <AdminPaymentsList />;
}

function AdminPaymentsList() {
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const tab = revenueTabFromParam(searchParams.get("tab"));
  const monthParam = searchParams.get("month");
  const [month, setMonth] = useState(() => (isRevenueMonth(monthParam) ? monthParam : currentMonthKey()));
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // The page number belongs to the filters it was chosen under: change any filter and it is page 1 again.
  const filterKey = `${month}|${tab}|${source}|${debouncedQuery}`;
  const [pageState, setPageState] = useState({ key: "", page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = useCallback((next: number) => setPageState({ key: filterKey, page: next }), [filterKey]);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<PaymentsState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ month, tab, source, page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    return params.toString();
  }, [month, tab, source, page, debouncedQuery]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/admin/revenue?${queryString}`, {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as Partial<AdminRevenuePage> & { error?: string; code?: string };
        if (cancelled) return;
        if (!res.ok || !json.rows || !json.summary || !json.counts) {
          setState({
            status: "error",
            code: json.code ?? null,
            message: json.code === "stripe_unavailable" ? "Stripe is not connected." : "Couldn't reach Stripe.",
          });
          return;
        }
        setState({ status: "ready", data: json as AdminRevenuePage });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          code: null,
          message: error instanceof FetchTimeoutError ? "That took too long to load." : "Couldn't reach Stripe.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryString, reloadTick]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setReloadTick((n) => n + 1);
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const testMode = data?.testMode ?? false;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const nowMonth = currentMonthKey();

  const destinations = REVENUE_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: data?.counts[t.id],
    href: `/admin/payments?tab=${t.id}&month=${month}`,
    dataAttr: `admin-payments-tab-${t.id}`,
  }));

  const download = () => {
    const params = new URLSearchParams({ month, tab, source, format: "csv" });
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    window.location.assign(`/api/admin/revenue?${params.toString()}`);
  };

  const bulkActions = selectedRow ? (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-payment-open"
        onClick={() => navigate(revenueRowHref(selectedRow, month))}
      >
        Open payment
      </Button>
      {accountHref(selectedRow) ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-payment-open-account"
          onClick={() => navigate(accountHref(selectedRow)!)}
        >
          Open account
        </Button>
      ) : null}
      {selectedRow.stripePath ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-payment-open-stripe"
          onClick={() => openStripe(selectedRow.stripePath!, testMode)}
        >
          Open in Stripe
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <ManagerPortalPageShell title="Payments" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      {testMode ? <AdminTestModeBanner /> : null}

      <div className="mb-3 flex items-center justify-between gap-2">
        <AdminMonthSwitcher
          month={month}
          canGoNext={month < nowMonth}
          onPrevious={() => setMonth((m) => shiftMonth(m, -1))}
          onNext={() => setMonth((m) => (m < nowMonth ? shiftMonth(m, 1) : m))}
        />
        {data?.truncated ? (
          <span className="text-[12.5px] text-[var(--status-warning-fg)]" role="status">
            Showing the first 1,500 transactions of the month.
          </span>
        ) : null}
      </div>

      {data ? <PaymentsStatStrip summary={data.summary} nextPayout={data.nextPayout} /> : null}

      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={destinations}
        activeDestinationId={tab}
        destinationAriaLabel="Payment type"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search payments, accounts or emails",
          dataAttr: "admin-payments-search",
          ariaLabel: "Search payments",
        }}
        actions={
          <>
            <PortalFilterSortSheet
              activeCount={portalFilterActiveCount([source !== "all" ? source : ""])}
              compactPanel
              commandStripTrigger
              filterFieldCount={1}
              constrainDropdownToTitleBand={false}
              mobileFlushBody
              onReset={() => setSource("all")}
              dataAttr="admin-payments-filter-sheet-open"
            >
              <FilterFieldsAccordion>
                <AdminSingleSelectFilterField
                  sectionId="payment-source"
                  label="Source"
                  value={source}
                  options={SOURCE_OPTIONS}
                  defaultValue="all"
                  defaultSummary="All sources"
                  onChange={setSource}
                  dataAttr="admin-payments-source"
                />
              </FilterFieldsAccordion>
            </PortalFilterSortSheet>
            <PortalIconAction icon={Download} label="Download CSV" data-attr="admin-payments-download" onClick={download} />
            <PortalIconAction
              icon={ExternalLink}
              label="Open in Stripe"
              data-attr="admin-payments-open-stripe"
              onClick={() => openStripe("payments", testMode)}
            />
          </>
        }
      />

      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="data"
            message={debouncedQuery.trim() ? "No payments match this search" : "No payments this month"}
          />
        }
        bulkCount={selectedRow ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-payments-list"
      >
        {rows.map((row) => {
          const Icon = row.source === "app_store" ? Smartphone : CATEGORY_ICON[row.category];
          const place = [row.email ?? row.accountName, dayLabel(row.created)].filter(Boolean).join(" · ");
          return (
            <PortalEntryRow
              key={row.id}
              tile={{ kind: "glyph", icon: Icon, label: revenueCategoryLabel(row.category) }}
              title={row.title}
              place={place}
              facts={rowFacts(row)}
              figure={{
                value: signedUsd(row.grossCents),
                tone: row.grossCents < 0 && row.category === "refunds" ? "bad" : undefined,
              }}
              checked={selectedId === row.id}
              onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
              onOpen={() => navigate(revenueRowHref(row, month))}
              dataAttr="admin-payment-row"
            />
          );
        })}
        {data ? (
          <AdminListPager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} dataAttr="admin-payments-pager" />
        ) : null}
      </PortalRecordListSurface>
    </ManagerPortalPageShell>
  );
}

function PaymentsStatStrip({
  summary,
  nextPayout,
}: {
  summary: RevenueSummary;
  nextPayout: AdminRevenuePage["nextPayout"];
}) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5" data-attr="admin-payments-stats">
      <StatTile label="Gross" value={formatAdminUsd(summary.grossCents)} dataAttr="admin-payments-stat-gross" />
      <StatTile label="Stripe fees" value={formatAdminUsd(summary.stripeFeesCents)} dataAttr="admin-payments-stat-fees" />
      <StatTile label="Net" value={formatAdminUsd(summary.netCents)} dataAttr="admin-payments-stat-net" />
      <StatTile label="Refunds" value={formatAdminUsd(summary.refundsCents)} dataAttr="admin-payments-stat-refunds" />
      <StatTile
        label="Next payout"
        value={nextPayout ? formatAdminUsd(nextPayout.amountCents) : "None"}
        detail={nextPayout?.arrivalDate ? dayLabel(nextPayout.arrivalDate) : nextPayout ? "Available" : undefined}
        dataAttr="admin-payments-stat-payout"
      />
    </div>
  );
}

// ------------------------------------------------------------- record page

function AdminPaymentRecord({ id }: { id: string }) {
  const searchParams = useSearchParams();
  const month = searchParams.get("month");
  const [row, setRow] = useState<RevenueRow | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ id });
        if (isRevenueMonth(month)) params.set("month", month);
        const res = await fetchWithTimeout(`/api/admin/revenue?${params.toString()}`, {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as { row?: RevenueRow; testMode?: boolean; code?: string };
        if (cancelled) return;
        if (!res.ok || !json.row) {
          setError(json.code === "not_found" ? "That payment was not found." : "Couldn't reach Stripe.");
          return;
        }
        setRow(json.row);
        setTestMode(json.testMode === true);
      } catch {
        if (!cancelled) setError("Couldn't reach Stripe.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, month, tick]);

  const backHref = `/admin/payments${isRevenueMonth(month) ? `?month=${month}` : ""}`;

  if (error) {
    return (
      <PortalRecordDetailPage title="Payment" backHref={backHref} backLabel="Payments">
        <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-[15px] font-semibold text-foreground">{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setTick((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </PortalRecordDetailPage>
    );
  }
  if (!row) {
    return (
      <PortalRecordDetailPage title="Payment" backHref={backHref} backLabel="Payments">
        <PortalDataTableEmpty icon="data" message="Loading…" />
      </PortalRecordDetailPage>
    );
  }

  const account = accountHref(row);
  const created = formatPacificDate(row.created, { year: "numeric", month: "short", day: "numeric" });
  return (
    <PortalRecordDetailPage
      title={row.title}
      subtitle={`${created} · ${signedUsd(row.grossCents)}`}
      avatarName={row.accountName ?? row.title}
      backHref={backHref}
      backLabel="Payments"
      iconTitleActions
      actions={
        <PortalRecordActions>
          {row.stripePath ? (
            <PortalIconAction
              ring
              icon={ExternalLink}
              label="Open in Stripe"
              data-attr="admin-payment-record-open-stripe"
              onClick={() => openStripe(row.stripePath!, testMode)}
            />
          ) : null}
          {account ? (
            <PortalIconAction
              ring
              icon={UserRound}
              label="Open account"
              data-attr="admin-payment-record-open-account"
              onClick={() => window.location.assign(account)}
            />
          ) : null}
        </PortalRecordActions>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6" data-attr="admin-payment-record">
        {testMode ? <AdminTestModeBanner /> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <RecordFactCard title="Payment" dataAttr="admin-payment-record-overview">
            <RecordFactRow label="Type" value={revenueCategoryLabel(row.category)} />
            <RecordFactRow label="Date" value={created} />
            <RecordFactRow label="Amount" value={signedUsd(row.grossCents)} />
            {row.category === "payouts" || row.category === "refunds" ? null : (
              <RecordFactRow label="Stripe fee" value={formatAdminUsd(-row.feeCents)} />
            )}
            <RecordFactRow label="Net" value={formatAdminUsd(row.netCents)} />
            <RecordFactRow
              label="Source"
              value={row.source === "app_store" ? "App Store" : row.source === "ledger" ? "PropLane ledger" : "Stripe"}
            />
            {row.payout?.arrivalDate ? (
              <RecordFactRow label="Arrives" value={formatPacificDate(row.payout.arrivalDate, { month: "short", day: "numeric", year: "numeric" })} />
            ) : null}
            {row.payout?.bankLast4 ? <RecordFactRow label="Bank" value={`****${row.payout.bankLast4}`} /> : null}
          </RecordFactCard>
          <RecordFactCard title="Account" dataAttr="admin-payment-record-account">
            <RecordFactRow
              label="Account"
              value={
                account ? (
                  <Link href={account} className="text-primary hover:underline">
                    {row.accountName ?? row.email ?? "Open account"}
                  </Link>
                ) : (
                  (row.accountName ?? "Not linked to an account")
                )
              }
            />
            {row.email ? <RecordFactRow label="Email" value={row.email} /> : null}
            {row.stripeCustomerId ? <RecordFactRow label="Customer" value={row.stripeCustomerId} /> : null}
          </RecordFactCard>
          <RecordFactCard title="Stripe" dataAttr="admin-payment-record-stripe">
            <RecordFactRow label="Transaction" value={row.id} />
            {row.chargeId ? <RecordFactRow label="Refunded charge" value={row.chargeId} /> : null}
            {row.invoiceId ? (
              <RecordFactRow
                label="Invoice"
                value={
                  row.hostedInvoiceUrl ? (
                    <a href={row.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      {row.invoiceId}
                      <ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  ) : (
                    row.invoiceId
                  )
                }
              />
            ) : null}
            {row.description ? <RecordFactRow label="Description" value={row.description} /> : null}
          </RecordFactCard>
        </div>
      </div>
    </PortalRecordDetailPage>
  );
}

export type { RevenueTabId };
