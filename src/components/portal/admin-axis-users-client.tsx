"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreditCard, Settings } from "lucide-react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
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
import { PortalPersonRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { AdminAccountRecordPage } from "@/components/portal/admin-account-record-page";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";

/**
 * Bounded so a slow/stuck admin API route surfaces the existing "Could not
 * load accounts" + Try again state instead of an indefinite "Loading…" — the
 * one route this page has for a fetch that never settles (AXI night sweep
 * area 2a).
 */
const ADMIN_FETCH_TIMEOUT_MS = 20_000;

type ManagerRow = {
  id: string;
  email: string;
  fullName: string;
  managerId: string;
  tier: string;
  billing: string;
  active: boolean;
  joinedAt: string | null;
};

type SimpleRow = {
  id: string;
  email: string;
  fullName: string;
  managerId: string;
  active: boolean;
  joinedAt: string | null;
};

type UnifiedRow =
  | ({ kind: "manager" } & ManagerRow)
  | ({ kind: "resident" } & SimpleRow)
  | ({ kind: "vendor" } & SimpleRow);

type CategoryFilter = "all" | "management" | "resident" | "vendor";
type StatusTab = "active" | "disabled";
type TierFilter = "all" | "free" | "pro" | "business";

/**
 * The wallet/plan facts `/api/admin/manager-billing` derives (`AdminBillingRow`,
 * `admin-billing-rows.ts`) — read-only and already computed by the same
 * resolvers billing enforcement uses. Kept as a narrow local shape (rather
 * than importing that module's runtime) since a value import from it would
 * pull in `manager-apple-purchase.ts`'s `server-only` marker.
 */
type ManagerBillingSummary = {
  planLabel: string;
  comms: {
    allowanceCents: number | null;
    remainingCents: number | null;
    exhausted: boolean;
  } | null;
};

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** `?category=` is user-supplied — only the four real categories are honoured. */
function categoryFromParam(raw: string | null): CategoryFilter {
  return raw === "management" || raw === "resident" || raw === "vendor" ? raw : "all";
}

/** Stable row key: `<kind>-<id>` — also the record page's URL segment. */
function rowKeyOf(row: { kind: string; id: string }): string {
  return `${row.kind}-${row.id}`;
}

/** The inverse of {@link rowKeyOf} — `kind` never contains a hyphen, so the first one is the split point. */
function parseRowKey(key: string): { kind: string; id: string } | null {
  const idx = key.indexOf("-");
  if (idx <= 0) return null;
  return { kind: key.slice(0, idx), id: key.slice(idx + 1) };
}

/** `$12.34 left`, `No credit left`, or `—` for a free plan / unread wallet. */
function commsCreditLabel(summary: ManagerBillingSummary | undefined): string | undefined {
  const comms = summary?.comms;
  if (!comms || comms.allowanceCents === null) return undefined;
  if (comms.exhausted) return "No credit left";
  if (comms.remainingCents === null) return "Unlimited";
  return `$${(comms.remainingCents / 100).toFixed(2)} left`;
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

/** Plan tier — same shape as {@link AccountStatusFilterField}, shown only for the Management category. */
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

export function AdminAxisUsersClient({ detailId }: { detailId?: string } = {}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [residents, setResidents] = useState<SimpleRow[]>([]);
  const [vendors, setVendors] = useState<SimpleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [billingById, setBillingById] = useState<Record<string, ManagerBillingSummary>>({});
  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  // Category is the top-level tab, so it lives in the URL like every other
  // portal list tab — a staff member can link someone straight to Vendors.
  const searchParams = useSearchParams();
  const category = categoryFromParam(searchParams.get("category"));
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  // Seeded from `?q=` so the Billing redirect card's "Find a manager" search
  // lands with the query already applied, not a blank list to re-search.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [selection, setSelection] = useState<{ category: CategoryFilter; ids: Set<string> }>(
    () => ({ category: "all", ids: new Set() }),
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

  const load = useCallback(async () => {
    if (isDemoModeActive()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [mRes, rRes, vRes] = await Promise.all([
        fetchWithTimeout("/api/admin/managers", {}, ADMIN_FETCH_TIMEOUT_MS),
        fetchWithTimeout("/api/admin/residents", {}, ADMIN_FETCH_TIMEOUT_MS),
        fetchWithTimeout("/api/admin/vendors", {}, ADMIN_FETCH_TIMEOUT_MS),
      ]);
      const mJson = (await mRes.json()) as { managers?: ManagerRow[]; error?: string };
      const rJson = (await rRes.json()) as { residents?: SimpleRow[]; error?: string };
      const vJson = (await vRes.json()) as { vendors?: SimpleRow[]; error?: string };
      if (!mRes.ok) {
        setLoadError(mJson.error ?? "Could not load manager accounts.");
        return;
      }
      if (!rRes.ok) {
        setLoadError(rJson.error ?? "Could not load resident accounts.");
        return;
      }
      if (!vRes.ok) {
        setLoadError(vJson.error ?? "Could not load vendor accounts.");
        return;
      }
      setManagers(mJson.managers ?? []);
      setResidents(rJson.residents ?? []);
      setVendors(vJson.vendors ?? []);
    } catch (error) {
      setLoadError(
        error instanceof FetchTimeoutError
          ? "That took too long to load."
          : "Could not reach the server. Check that Supabase env vars are configured.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // Each manager row's plan and remaining communication credit (C167) — one
  // bulk read, same route the retired Billing list used, never a per-row
  // fan-out (the accounts list already learned that lesson).
  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/manager-billing", {}, ADMIN_FETCH_TIMEOUT_MS);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          rows?: { id: string; planLabel: string; comms: ManagerBillingSummary["comms"] }[];
        };
        if (cancelled) return;
        const next: Record<string, ManagerBillingSummary> = {};
        for (const row of data.rows ?? []) {
          next[row.id] = { planLabel: row.planLabel, comms: row.comms };
        }
        setBillingById(next);
      } catch {
        // Rows still render with the plain plan text below; comms credit
        // just reads "—" until a retry succeeds.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [managers.length]);

  const unified = useMemo((): UnifiedRow[] => {
    const m: UnifiedRow[] = managers.map((r) => ({ kind: "manager" as const, ...r }));
    const res: UnifiedRow[] = residents.map((r) => ({ kind: "resident" as const, ...r }));
    const ven: UnifiedRow[] = vendors.map((r) => ({ kind: "vendor" as const, ...r }));
    return [...m, ...res, ...ven].sort((a, b) => {
      const an = (a.email || a.kind).toLowerCase();
      const bn = (b.email || b.kind).toLowerCase();
      return an.localeCompare(bn);
    });
  }, [managers, residents, vendors]);

  const categoryCounts = useMemo(() => {
    const c = { all: unified.length, management: 0, resident: 0, vendor: 0 };
    for (const row of unified) {
      if (row.kind === "resident") c.resident += 1;
      else if (row.kind === "vendor") c.vendor += 1;
      else c.management += 1;
    }
    return c;
  }, [unified]);

  const rowMatchesCategory = (row: UnifiedRow, cat: CategoryFilter) => {
    if (cat === "all") return true;
    if (cat === "resident") return row.kind === "resident";
    if (cat === "vendor") return row.kind === "vendor";
    return row.kind === "manager";
  };

  const rowMatchesQuery = (row: UnifiedRow, q: string) => {
    if (!q) return true;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      row.email.toLowerCase().includes(needle) ||
      (row.fullName || "").toLowerCase().includes(needle) ||
      row.managerId.toLowerCase().includes(needle)
    );
  };

  const { activeCount, disabledCount } = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const row of unified) {
      if (!rowMatchesCategory(row, category)) continue;
      if (!rowMatchesQuery(row, query)) continue;
      if (row.kind === "manager" && tierFilter !== "all" && row.tier.toLowerCase() !== tierFilter) continue;
      if (row.active) a += 1;
      else d += 1;
    }
    return { activeCount: a, disabledCount: d };
  }, [category, tierFilter, unified, query]);

  const visible = useMemo(() => {
    return unified.filter((row) => {
      if (statusTab === "active" && !row.active) return false;
      if (statusTab === "disabled" && row.active) return false;
      if (!rowMatchesCategory(row, category)) return false;
      if (!rowMatchesQuery(row, query)) return false;
      if (row.kind === "manager" && tierFilter !== "all" && row.tier.toLowerCase() !== tierFilter) return false;
      return true;
    });
  }, [unified, statusTab, category, tierFilter, query]);

  const showTierFilter = category === "management";

  const STATUS_TABS: { id: StatusTab; label: string; count: number; dataAttr: string }[] = [
    { id: "active", label: "Active", count: activeCount, dataAttr: "admin-accounts-status-active" },
    { id: "disabled", label: "Disabled", count: disabledCount, dataAttr: "admin-accounts-status-disabled" },
  ];

  const ROLE_TABS = [
    { id: "all", label: "All", count: categoryCounts.all },
    { id: "management", label: "Managers", count: categoryCounts.management },
    { id: "resident", label: "Residents", count: categoryCounts.resident },
    { id: "vendor", label: "Vendors", count: categoryCounts.vendor },
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

  const selectedRows = visible.filter((row) => selectedIds.has(rowKeyOf(row)));

  const openRow = useCallback(
    (row: UnifiedRow) => navigate(`/admin/axis-users/${encodeURIComponent(rowKeyOf(row))}`),
    [navigate],
  );

  /**
   * Opening an account's editor is what staff do here, so the dock carries the
   * one action that makes sense on a selection: open it. Enable / disable and
   * the rest stay inside that editor, beside what they change — the house rule
   * for anything a stray tick should not reach.
   */
  const bulkActions =
    selectedRows.length === 1 ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-account-open"
        onClick={() => openRow(selectedRows[0]!)}
      >
        Open account
      </Button>
    ) : null;

  // A detail route names a row by `<kind>-<id>` — stable across a reload and
  // decodable without a second network round trip.
  const detailMatch = useMemo(() => {
    if (!detailId) return undefined;
    const parsed = parseRowKey(detailId);
    if (!parsed) return null;
    return unified.find((row) => row.kind === parsed.kind && row.id === parsed.id) ?? null;
  }, [detailId, unified]);

  if (detailId) {
    if (loading) {
      return (
        <ManagerPortalPageShell title="Accounts" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null}>
          <PortalDataTableEmpty icon="data" message="Loading…" />
        </ManagerPortalPageShell>
      );
    }
    if (!detailMatch) {
      return (
        <ManagerPortalPageShell title="Accounts" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null}>
          <PortalDataTableEmpty icon="data" message="Account not found" />
        </ManagerPortalPageShell>
      );
    }
    const backCategory: CategoryFilter =
      detailMatch.kind === "resident" ? "resident" : detailMatch.kind === "vendor" ? "vendor" : "management";
    return (
      <AdminAccountRecordPage
        row={detailMatch}
        backHref={`/admin/axis-users?category=${backCategory}`}
        planLabel={detailMatch.kind === "manager" ? (billingById[detailMatch.id]?.planLabel ?? detailMatch.tier) : undefined}
        commsLabel={detailMatch.kind === "manager" ? commsCreditLabel(billingById[detailMatch.id]) : undefined}
        onRefresh={() => void load()}
        showToast={showToast}
      />
    );
  }

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
          placeholder: "Search accounts",
          dataAttr: "admin-accounts-search",
          ariaLabel: "Search accounts",
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

      {loading ? (
        <PortalDataTableEmpty icon="data" message="Loading…" />
      ) : loadError ? (
        <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-danger">
          Could not load accounts: {loadError}
          <button type="button" onClick={() => void load()} className="ml-2 font-semibold underline underline-offset-2">
            Try again
          </button>
        </div>
      ) : (
        /*
          One flat list at every breakpoint. There used to be two — a desktop
          table and a separate mobile card stack rendering the same rows from
          the same data — which is two places for the same list to drift.
        */
        <PortalRecordListSurface
          isEmpty={visible.length === 0}
          empty={
            <PortalDataTableEmpty
              icon="data"
              message={unified.length === 0 ? "No accounts yet" : "No accounts match these filters"}
            />
          }
          bulkCount={selectedRows.length}
          bulkActions={bulkActions}
          dataAttr="admin-accounts-list"
        >
          {visible.map((row) => {
            const rowKey = rowKeyOf(row);
            const billing = row.kind === "manager" ? billingById[row.id] : undefined;
            const comms = row.kind === "manager" ? commsCreditLabel(billing) : undefined;
            return (
              <PortalPersonRecordRow
                key={rowKey}
                name={row.fullName || row.email}
                subtitle={row.email}
                meta={row.managerId || undefined}
                checked={selectedIds.has(rowKey)}
                onSelectedChange={() => toggleSelected(rowKey)}
                onOpen={() => openRow(row)}
                dataAttr="admin-account-row"
                trailing={
                  row.kind === "manager" ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[13px] font-semibold text-foreground">
                        {billing?.planLabel ?? "Plan —"}
                      </span>
                      {comms ? (
                        <span className="text-[11px] text-muted">
                          <PortalRowFact icon={CreditCard} srLabel="Communication credit">
                            {comms}
                          </PortalRowFact>
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-[13px] font-medium text-muted">{row.active ? "Active" : "Disabled"}</span>
                  )
                }
              />
            );
          })}
        </PortalRecordListSurface>
      )}
    </ManagerPortalPageShell>
  );
}
