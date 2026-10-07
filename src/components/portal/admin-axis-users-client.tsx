"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Building2, Clock, Coins, CreditCard, Settings } from "lucide-react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { Modal } from "@/components/ui/modal";
import { PlanCreditRulesSection } from "@/components/portal/admin-billing-client";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { AdminAccountRecordPage } from "@/components/portal/admin-account-record-page";
import { useAdminAccountActions } from "@/components/portal/use-admin-account-actions";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDate } from "@/lib/pacific-time";
import {
  adminAccountCategory,
  adminAccountKey,
  parseAdminAccountKey,
  type AdminAccountRowKind,
} from "@/lib/admin/admin-account-keys";
import type { AdminAccountSearchResult, AdminAccountSearchRow } from "@/lib/admin/admin-accounts-search.server";

/**
 * Bounded so a slow/stuck admin API route surfaces the existing "Could not
 * load accounts" + Try again state instead of an indefinite "Loading…" — the
 * one route this page has for a fetch that never settles (AXI night sweep
 * area 2a).
 */
const ADMIN_FETCH_TIMEOUT_MS = 20_000;
const SEARCH_DEBOUNCE_MS = 250;

type CategoryFilter = "management" | "resident" | "vendor";
type StatusTab = "active" | "disabled";
type TierFilter = "all" | "free" | "pro" | "business";

/**
 * The plan facts `/api/admin/manager-billing` derives (`AdminBillingRow`,
 * `admin-billing-rows.ts`) — read-only and already computed by the same
 * resolvers billing enforcement uses. Kept as a narrow local shape (rather
 * than importing that module's runtime) since a value import from it would
 * pull in `manager-apple-purchase.ts`'s `server-only` marker.
 */
type ManagerBillingSummary = {
  planLabel: string;
  storedTier: string;
};

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** `?category=` is user-supplied — only the three real categories are honoured. */
function categoryFromParam(raw: string | null): CategoryFilter {
  return raw === "resident" || raw === "vendor" ? raw : "management";
}

function kindOfCategory(category: CategoryFilter): AdminAccountRowKind {
  return category === "management" ? "manager" : category;
}

/** "Signed in Oct 4, 2026", or "Never signed in". */
function lastSignInLabel(iso: string | null): string {
  if (!iso) return "Never signed in";
  return `Signed in ${formatPacificDate(iso, { year: "numeric", month: "short", day: "numeric" })}`;
}

/**
 * Status is a single-select filter field inside the shared Filter sheet — same
 * shape as `PortalListGroupModeField` (`portal-list-group-filter-fields.tsx`):
 * a real component rendered as a `FilterFieldsAccordion` child, so
 * `useFilterAccordionClose` resolves the enclosing accordion's context.
 */
function AccountStatusFilterField({
  value,
  options,
  onChange,
}: {
  value: StatusTab;
  options: { id: StatusTab; label: string; dataAttr: string }[];
  onChange: (next: StatusTab) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const selectOptions = options.map((opt) => ({ value: opt.id, label: opt.label }));
  const summary = filterSingleSelectSummary(value, selectOptions, "Active");

  return (
    <FilterCollapsibleSection
      sectionId="account-status"
      label="Status"
      summary={summary}
      empty={value === "active"}
      menuOptionCount={selectOptions.length}
      dataAttr="admin-accounts-status-trigger"
    >
      <FilterSingleSelectList
        options={selectOptions}
        value={value}
        onChange={(next) => onChange(next as StatusTab)}
        onPick={closeFieldMenu}
        dataAttr="admin-accounts-status"
      />
    </FilterCollapsibleSection>
  );
}

/** Plan tier — same shape as {@link AccountStatusFilterField}, shown only for the Managers tab. */
function AccountTierFilterField({
  value,
  options,
  onChange,
}: {
  value: TierFilter;
  options: { id: TierFilter; label: string; dataAttr: string }[];
  onChange: (next: TierFilter) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const selectOptions = options.map((opt) => ({ value: opt.id, label: opt.label }));
  const summary = filterSingleSelectSummary(value, selectOptions, "All tiers");

  return (
    <FilterCollapsibleSection
      sectionId="account-tier"
      label="Plan tier"
      summary={summary}
      empty={value === "all"}
      menuOptionCount={selectOptions.length}
      dataAttr="admin-accounts-tier-trigger"
    >
      <FilterSingleSelectList
        options={selectOptions}
        value={value}
        onChange={(next) => onChange(next as TierFilter)}
        onPick={closeFieldMenu}
        dataAttr="admin-accounts-tier"
      />
    </FilterCollapsibleSection>
  );
}

export function AdminAxisUsersClient({
  detailId,
  detailSection,
}: { detailId?: string; detailSection?: string } = {}) {
  const navigate = usePortalNavigate();
  if (detailId) {
    const parsed = parseAdminAccountKey(detailId);
    return (
      <AdminAccountRecordPage
        parsed={parsed}
        section={detailSection}
        backHref={`/admin/axis-users?category=${parsed ? adminAccountCategory(parsed.kind) : "management"}`}
        onDeleted={() => navigate(`/admin/axis-users?category=${parsed ? adminAccountCategory(parsed.kind) : "management"}`)}
      />
    );
  }
  return <AdminAccountsList />;
}

function AdminAccountsList() {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  // Category is the top-level tab, so it lives in the URL like every other
  // portal list tab — a staff member can link someone straight to Vendors.
  const searchParams = useSearchParams();
  const category = categoryFromParam(searchParams.get("category"));
  const kind = kindOfCategory(category);

  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  // Global per-plan messaging-credit defaults (S27) — a GLOBAL, not
  // per-account, setting, so it lives behind a header action rather than
  // inside any one row's editor. See `PlanCreditRulesSection`'s doc comment
  // (admin-billing-client.tsx) for why it mounts here.
  const [planCreditOpen, setPlanCreditOpen] = useState(false);
  // Seeded from `?q=` so the Billing redirect card's "Find a manager" search
  // lands with the query already applied, not a blank list to re-search.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  const [result, setResult] = useState<AdminAccountSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [billingById, setBillingById] = useState<Record<string, ManagerBillingSummary>>({});

  const [selection, setSelection] = useState<{ category: CategoryFilter; ids: Set<string> }>(
    () => ({ category: "management", ids: new Set() }),
  );
  const selectedIds = selection.category === category ? selection.ids : EMPTY_SELECTION;
  const toggleSelected = useCallback(
    (key: string) => {
      setSelection((prev) => {
        const base = prev.category === category ? prev.ids : EMPTY_SELECTION;
        const next = new Set(base);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return { category, ids: next };
      });
    },
    [category],
  );

  const { busy: actionBusy, setActive, remove } = useAdminAccountActions(reload);

  // The match runs on the server (name, email, phone or PropLane ID) so the
  // three tab counts always describe the same query.
  useEffect(() => {
    if (isDemoModeActive()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ kind, q: debouncedQuery });
        const res = await fetchWithTimeout(`/api/admin/accounts/search?${params.toString()}`, {}, ADMIN_FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as Partial<AdminAccountSearchResult> & { error?: string };
        if (cancelled) return;
        if (!res.ok || !json.rows || !json.counts) {
          setLoadError(json.error ?? "Could not load accounts.");
          return;
        }
        setResult({ rows: json.rows, counts: json.counts });
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          error instanceof FetchTimeoutError
            ? "That took too long to load."
            : "Could not reach the server. Check that Supabase env vars are configured.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, debouncedQuery, reloadTick]);

  // Each manager row's plan (C167) — one bulk read, same route the retired
  // Billing list used, never a per-row fan-out.
  useEffect(() => {
    if (isDemoModeActive() || kind !== "manager") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/manager-billing", {}, ADMIN_FETCH_TIMEOUT_MS);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { rows?: { id: string; planLabel: string; storedTier: string }[] };
        if (cancelled) return;
        const next: Record<string, ManagerBillingSummary> = {};
        for (const row of data.rows ?? []) next[row.id] = { planLabel: row.planLabel, storedTier: row.storedTier };
        setBillingById(next);
      } catch {
        // Rows still render; the plan fact just reads "Plan —" until a retry succeeds.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, reloadTick]);

  const rows = result?.rows ?? [];
  const tierMatches = useCallback(
    (row: AdminAccountSearchRow) =>
      kind !== "manager" || tierFilter === "all" || (billingById[row.id]?.storedTier ?? "").toLowerCase() === tierFilter,
    [kind, tierFilter, billingById],
  );

  const visible = useMemo(
    () =>
      rows.filter((row) => (statusTab === "active" ? row.active : !row.active)).filter(tierMatches),
    [rows, statusTab, tierMatches],
  );
  const disabledCount = useMemo(() => rows.filter((row) => !row.active).length, [rows]);

  const showTierFilter = kind === "manager";

  const STATUS_TABS: { id: StatusTab; label: string; dataAttr: string }[] = [
    { id: "active", label: "Active", dataAttr: "admin-accounts-status-active" },
    { id: "disabled", label: `Disabled${disabledCount ? ` (${disabledCount})` : ""}`, dataAttr: "admin-accounts-status-disabled" },
  ];

  const counts = result?.counts;
  const ROLE_TABS = [
    { id: "management", label: "Managers", count: counts?.manager },
    { id: "resident", label: "Residents", count: counts?.resident },
    { id: "vendor", label: "Vendors", count: counts?.vendor },
  ].map((tab) => ({
    ...tab,
    href: `/admin/axis-users?category=${tab.id}`,
    dataAttr: `admin-accounts-tab-${tab.id}`,
  }));

  const TIER_OPTIONS: { id: TierFilter; label: string; dataAttr: string }[] = [
    { id: "all", label: "All tiers", dataAttr: "admin-accounts-tier-all" },
    { id: "free", label: "Free", dataAttr: "admin-accounts-tier-free" },
    { id: "pro", label: "Pro", dataAttr: "admin-accounts-tier-pro" },
    { id: "business", label: "Business", dataAttr: "admin-accounts-tier-business" },
  ];

  const selectedRows = visible.filter((row) => selectedIds.has(adminAccountKey(row.kind, row.id)));

  const openRow = useCallback(
    (row: AdminAccountSearchRow) => navigate(`/admin/axis-users/${encodeURIComponent(adminAccountKey(row.kind, row.id))}`),
    [navigate],
  );

  /**
   * The row ⋯ (and the dock for the one row it applies to): Open, Copy
   * PropLane ID, Disable / Enable, then the red Delete last.
   */
  const bulkActions =
    selectedRows.length === 1 ? (
      <>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-account-open"
          onClick={() => openRow(selectedRows[0]!)}
        >
          Open
        </Button>
        {selectedRows[0]!.managerId ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="admin-account-copy-id"
            onClick={() => {
              const id = selectedRows[0]!.managerId;
              void navigator.clipboard
                .writeText(id)
                .then(() => showToast("PropLane ID copied."))
                .catch(() => showToast("Could not copy the PropLane ID."));
            }}
          >
            Copy PropLane ID
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-account-toggle-active"
          disabled={actionBusy}
          onClick={() => void setActive(selectedRows[0]!.kind, selectedRows[0]!.id, !selectedRows[0]!.active)}
        >
          {selectedRows[0]!.active ? "Disable" : "Enable"}
        </Button>
        <Button
          type="button"
          variant="danger"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-account-delete"
          disabled={actionBusy}
          onClick={() =>
            void remove(
              selectedRows[0]!.kind,
              selectedRows[0]!.id,
              selectedRows[0]!.fullName || selectedRows[0]!.email,
            )
          }
        >
          Delete
        </Button>
      </>
    ) : null;

  return (
    <ManagerPortalPageShell
      title="Accounts"
      hideTitleOnMobileNav
      navigationProvidesTitle
      titleInlineFilter={null}
      compactFilterRow
    >
      {/*
        One command header — counted category tabs in a card, with status and
        plan tier behind the shared Filter sheet instead of labelled pills
        reaching the list band: utilities there are icon-only
        (docs/portal-list-section-layout.md; the dev-mode guard flagged this
        as `[portal-list-control-stack] a labeled pill ("Active") reached the
        list band`).
      */}
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={ROLE_TABS}
        activeDestinationId={category}
        destinationAriaLabel="Account category"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search name, email, phone or PropLane ID",
          dataAttr: "admin-accounts-search",
          ariaLabel: "Search accounts by name, email, phone or PropLane ID",
        }}
        actions={
          <>
            <PortalFilterSortSheet
              activeCount={portalFilterActiveCount([
                statusTab !== "active" ? statusTab : "",
                showTierFilter && tierFilter !== "all" ? tierFilter : "",
              ])}
              compactPanel
              commandStripTrigger
              filterFieldCount={showTierFilter ? 2 : 1}
              constrainDropdownToTitleBand={false}
              mobileFlushBody
              onReset={() => {
                setStatusTab("active");
                setTierFilter("all");
              }}
              dataAttr="admin-accounts-filter-sheet-open"
            >
              <FilterFieldsAccordion>
                <AccountStatusFilterField value={statusTab} options={STATUS_TABS} onChange={setStatusTab} />
                {showTierFilter ? (
                  <AccountTierFilterField value={tierFilter} options={TIER_OPTIONS} onChange={setTierFilter} />
                ) : null}
              </FilterFieldsAccordion>
            </PortalFilterSortSheet>
            {/* Global per-plan messaging-credit defaults (S27) — not one account's
                setting, so it opens in a modal from the header rather than living
                inside a row's editor. See admin-billing-client.tsx's
                PlanCreditRulesSection doc comment. */}
            <PortalIconAction
              icon={Coins}
              label="Plan credit"
              data-attr="admin-plan-credit-open"
              onClick={() => setPlanCreditOpen(true)}
            />
            {/* Matches every manager list page's command header — search + Filter + a
                settings gear into the shared Settings screen (mock: "search and a
                settings gear are back"). */}
            <PortalIconAction
              icon={Settings}
              label="Account settings"
              data-attr="admin-accounts-settings"
              onClick={() => navigate("/admin/profile")}
            />
          </>
        }
      />

      {/*
        One flat list at every breakpoint. There used to be two — a desktop
        table and a separate mobile card stack rendering the same rows from
        the same data — which is two places for the same list to drift.
      */}
      <PortalRecordListSurface
        loading={loading && !result}
        loadError={loadError ?? undefined}
        onRetry={reload}
        isEmpty={visible.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="data"
            message={debouncedQuery.trim() ? "No accounts match this search" : rows.length === 0 ? "No accounts yet" : "No accounts match these filters"}
          />
        }
        bulkCount={selectedRows.length}
        bulkActions={bulkActions}
        onBulkClear={() => setSelection({ category, ids: new Set() })}
        dataAttr="admin-accounts-list"
      >
        {visible.map((row) => {
          const rowKey = adminAccountKey(row.kind, row.id);
          const billing = row.kind === "manager" ? billingById[row.id] : undefined;
          const facts: PortalEntryRowFact[] = [];
          if (row.kind === "manager") {
            facts.push({ icon: CreditCard, label: billing?.planLabel ?? "Plan —", srLabel: "Plan" });
            facts.push({
              icon: Building2,
              label: `${row.workspaceCount ?? 0} ${(row.workspaceCount ?? 0) === 1 ? "workspace" : "workspaces"}`,
            });
          }
          facts.push({ icon: Clock, label: lastSignInLabel(row.lastSignInAt), srLabel: "Last sign-in" });
          return (
            <PortalEntryRow
              key={rowKey}
              tile={{ kind: "initials", label: row.fullName || row.email }}
              title={row.fullName || row.email}
              place={row.fullName ? row.email : undefined}
              facts={facts}
              figure={row.active ? undefined : { value: "Disabled", tone: "bad" }}
              checked={selectedIds.has(rowKey)}
              onSelectedChange={() => toggleSelected(rowKey)}
              onOpen={() => openRow(row)}
              dataAttr="admin-account-row"
            />
          );
        })}
      </PortalRecordListSurface>

      {/*
        Renders via Radix Dialog.Portal regardless of nesting depth, so it can
        sit here as an ordinary child rather than a Fragment-wrapped sibling
        of ManagerPortalPageShell (tests/unit/admin-list-surface-adoption.test.ts
        locates the header dock by slicing up to the literal
        "return (\n    <ManagerPortalPageShell" string).
      */}
      <Modal
        open={planCreditOpen}
        title="Plan credit"
        onClose={() => setPlanCreditOpen(false)}
        assistantStrip={false}
        dataAttr="admin-plan-credit-modal"
      >
        <PlanCreditRulesSection />
      </Modal>
    </ManagerPortalPageShell>
  );
}
