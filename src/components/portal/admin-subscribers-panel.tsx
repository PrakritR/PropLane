"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, Download, Smartphone, Tag } from "lucide-react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { FilterFieldsAccordion } from "@/components/portal/filter-field-lists";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { AdminListPager, AdminSingleSelectFilterField } from "@/components/portal/admin-money-ui";
import { Button } from "@/components/ui/button";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDate, pacificCalendarMonthKey } from "@/lib/pacific-time";
import { formatAdminUsd, shiftMonth, stripeDashboardUrl } from "@/lib/admin/admin-revenue-model";
import {
  SUBSCRIBER_TABS,
  subscriberTabFromParam,
  trialEndsSoon,
  type SubscriberCounts,
  type SubscriberRow,
  type SubscriberSource,
} from "@/lib/admin/admin-subscribers-shared";

const FETCH_TIMEOUT_MS = 25_000;
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE = 50;

type PlanFilter = "all" | "pro" | "business";
type SourceFilter = "all" | SubscriberSource;

const PLAN_OPTIONS: { value: PlanFilter; label: string }[] = [
  { value: "all", label: "All plans" },
  { value: "pro", label: "Pro" },
  { value: "business", label: "Business" },
];

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All billing sources" },
  { value: "stripe", label: "Stripe" },
  { value: "app_store", label: "App Store" },
  { value: "proplane", label: "Granted by PropLane" },
];

type SubscribersPage = {
  rows: SubscriberRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: SubscriberCounts;
  mrrCents: number;
  unreadable: number;
  testMode: boolean;
};

type State =
  | { status: "loading" }
  | { status: "ready"; data: SubscribersPage }
  | { status: "error"; message: string };

const day = (iso: string) => formatPacificDate(iso, { month: "short", day: "numeric" });

/** Last twelve sign-up months, newest first. */
function signupMonthOptions(): { value: string; label: string }[] {
  const nowMonth = pacificCalendarMonthKey(Date.now());
  const options = [{ value: "", label: "Any month" }];
  for (let i = 0; i < 12; i += 1) {
    const month = shiftMonth(nowMonth, -i);
    options.push({ value: month, label: formatPacificDate(`${month}-15T12:00:00Z`, { month: "long", year: "numeric" }) });
  }
  return options;
}

function accountHref(row: SubscriberRow, action?: "promo" | "extend-trial"): string {
  const base = `/admin/axis-users/${encodeURIComponent(row.accountKey)}`;
  return action ? `${base}/billing?action=${action}` : base;
}

function stripePathOf(row: SubscriberRow): string | null {
  if (row.stripeSubscriptionId) return `subscriptions/${row.stripeSubscriptionId}`;
  if (row.stripeCustomerId) return `customers/${row.stripeCustomerId}`;
  return null;
}

/** The (at most three) glyph facts on a subscriber row. */
export function subscriberFacts(row: SubscriberRow): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [];
  if (row.since) facts.push({ icon: CalendarDays, label: `Since ${day(row.since)}`, srLabel: "Since" });
  if (row.bucket === "trial" && row.trialEndsAt) {
    const soon = trialEndsSoon(row);
    const label: ReactNode = soon ? (
      <span className="font-medium text-[var(--status-warning-fg)]" data-attr="admin-subscriber-trial-soon">
        {row.trialDaysLeft === 0
          ? "Ends today"
          : `Ends in ${row.trialDaysLeft} ${row.trialDaysLeft === 1 ? "day" : "days"}`}
      </span>
    ) : (
      `Trial ends ${day(`${row.trialEndsAt}T12:00:00Z`)}`
    );
    facts.push({ icon: CalendarDays, label, srLabel: "Trial end" });
  } else if (row.renewsAt) {
    facts.push({ icon: CalendarDays, label: `Renews ${day(row.renewsAt)}`, srLabel: "Renews" });
  }
  if (row.promoCode) facts.push({ icon: Tag, label: `Code ${row.promoCode}`, srLabel: "Promo code" });
  else if (row.source === "app_store") facts.push({ icon: Smartphone, label: "via App Store", srLabel: "Billing source" });
  return facts;
}

export function AdminSubscribersPanel() {
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const tab = subscriberTabFromParam(searchParams.get("tab"));
  const [plan, setPlan] = useState<PlanFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [signup, setSignup] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // The page number belongs to the filters it was chosen under: change any filter and it is page 1 again.
  const filterKey = `${tab}|${plan}|${source}|${signup}|${debouncedQuery}`;
  const [pageState, setPageState] = useState({ key: "", page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = useCallback((next: number) => setPageState({ key: filterKey, page: next }), [filterKey]);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const filterParams = useMemo(() => {
    const params = new URLSearchParams({ tab, plan, source });
    if (signup) params.set("signup", signup);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    return params;
  }, [tab, plan, source, signup, debouncedQuery]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams(filterParams);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));
        const res = await fetchWithTimeout(`/api/admin/subscribers?${params.toString()}`, {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as Partial<SubscribersPage> & { error?: string };
        if (cancelled) return;
        if (!res.ok || !json.rows || !json.counts) {
          setState({ status: "error", message: "Could not load subscribers." });
          return;
        }
        setState({ status: "ready", data: json as SubscribersPage });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof FetchTimeoutError ? "That took too long to load." : "Could not load subscribers.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filterParams, page, reloadTick]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setReloadTick((n) => n + 1);
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selectedRow = rows.find((row) => row.id === selectedId) ?? null;
  const months = useMemo(() => signupMonthOptions(), []);

  const destinations = SUBSCRIBER_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    count: data?.counts[t.id],
    href: `/admin/subscribers?tab=${t.id}`,
    dataAttr: `admin-subscribers-tab-${t.id}`,
  }));

  const download = () => {
    const params = new URLSearchParams(filterParams);
    params.set("format", "csv");
    window.location.assign(`/api/admin/subscribers?${params.toString()}`);
  };

  const stripePath = selectedRow ? stripePathOf(selectedRow) : null;
  const bulkActions = selectedRow ? (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-subscriber-open-account"
        onClick={() => navigate(accountHref(selectedRow))}
      >
        Open account
      </Button>
      {selectedRow.bucket !== "complimentary" ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-subscriber-apply-promo"
          onClick={() => navigate(accountHref(selectedRow, "promo"))}
        >
          Apply promo code
        </Button>
      ) : null}
      {selectedRow.bucket === "trial" ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-subscriber-extend-trial"
          onClick={() => navigate(accountHref(selectedRow, "extend-trial"))}
        >
          Extend trial
        </Button>
      ) : null}
      {stripePath ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-subscriber-open-stripe"
          onClick={() =>
            window.open(stripeDashboardUrl(stripePath, data?.testMode ?? false), "_blank", "noopener,noreferrer")
          }
        >
          Open in Stripe
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <ManagerPortalPageShell title="Subscribers" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={destinations}
        activeDestinationId={tab}
        destinationAriaLabel="Subscriber type"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search name, email or promo code",
          dataAttr: "admin-subscribers-search",
          ariaLabel: "Search subscribers",
        }}
        actions={
          <>
            <PortalFilterSortSheet
              activeCount={portalFilterActiveCount([
                plan !== "all" ? plan : "",
                source !== "all" ? source : "",
                signup,
              ])}
              compactPanel
              commandStripTrigger
              filterFieldCount={3}
              constrainDropdownToTitleBand={false}
              mobileFlushBody
              onReset={() => {
                setPlan("all");
                setSource("all");
                setSignup("");
              }}
              dataAttr="admin-subscribers-filter-sheet-open"
            >
              <FilterFieldsAccordion>
                <AdminSingleSelectFilterField
                  sectionId="subscriber-plan"
                  label="Plan"
                  value={plan}
                  options={PLAN_OPTIONS}
                  defaultValue="all"
                  defaultSummary="All plans"
                  onChange={setPlan}
                  dataAttr="admin-subscribers-plan"
                />
                <AdminSingleSelectFilterField
                  sectionId="subscriber-source"
                  label="Billing source"
                  value={source}
                  options={SOURCE_OPTIONS}
                  defaultValue="all"
                  defaultSummary="All billing sources"
                  onChange={setSource}
                  dataAttr="admin-subscribers-source"
                />
                <AdminSingleSelectFilterField
                  sectionId="subscriber-signup"
                  label="Signup month"
                  value={signup}
                  options={months}
                  defaultValue=""
                  defaultSummary="Any month"
                  onChange={setSignup}
                  dataAttr="admin-subscribers-signup"
                />
              </FilterFieldsAccordion>
            </PortalFilterSortSheet>
            <PortalIconAction icon={Download} label="Download CSV" data-attr="admin-subscribers-download" onClick={download} />
          </>
        }
      />

      {data && data.unreadable > 0 ? (
        <p className="mb-2 px-1 text-[13px] text-[var(--status-warning-fg)]" role="status" data-attr="admin-subscribers-unreadable">
          {data.unreadable} {data.unreadable === 1 ? "account's plan" : "accounts' plans"} could not be read and{" "}
          {data.unreadable === 1 ? "is" : "are"} not counted.
        </p>
      ) : null}

      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="data"
            message={debouncedQuery.trim() ? "No subscribers match this search" : "No subscribers here yet"}
          />
        }
        bulkCount={selectedRow ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-subscribers-list"
      >
        {rows.map((row) => (
          <PortalEntryRow
            key={row.id}
            tile={{ kind: "initials", label: row.name || row.email }}
            title={row.name || row.email}
            place={row.name ? `${row.email} · ${row.planLabel}` : row.planLabel}
            facts={subscriberFacts(row)}
            figure={row.monthlyCents !== null ? { value: `${formatAdminUsd(row.monthlyCents, { whole: row.monthlyCents % 100 === 0 })}/mo` } : undefined}
            checked={selectedId === row.id}
            onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
            onOpen={() => navigate(accountHref(row))}
            dataAttr="admin-subscriber-row"
          />
        ))}
        {data ? (
          <AdminListPager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} dataAttr="admin-subscribers-pager" />
        ) : null}
      </PortalRecordListSurface>
    </ManagerPortalPageShell>
  );
}
