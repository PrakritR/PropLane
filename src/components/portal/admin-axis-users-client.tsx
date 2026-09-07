"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ManagerPortalPageShell,
  PORTAL_TOOLBAR_GROUP,
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import {
  ManagerAccountDetail,
  StatusPill,
  TierBadge,
} from "@/components/portal/admin-manager-account-detail";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatPacificDate } from "@/lib/pacific-time";
import { isDemoModeActive } from "@/lib/demo/demo-session";

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

type CategoryFilter = "management" | "resident" | "vendor";
type StatusTab = "active" | "disabled";
type TierFilter = "all" | "free" | "pro" | "business";

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** `?category=` is user-supplied — only the three real categories are honoured. */
function categoryFromParam(raw: string | null): CategoryFilter {
  return raw === "resident" || raw === "vendor" ? raw : "management";
}
function SimpleAccountDetailContent({
  row,
  apiPath,
  accountLabel,
  onRefresh,
  showToast,
}: {
  row: { kind: "resident" | "vendor" } & SimpleRow;
  apiPath: "/api/admin/residents" | "/api/admin/vendors";
  accountLabel: string;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const res = await fetch(apiPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, active: !row.active }),
      });
      if (!res.ok) {
        showToast("Could not update account.");
        return;
      }
      showToast(
        row.active
          ? `${accountLabel} account disabled.`
          : `${accountLabel} account enabled.`,
      );
      onRefresh();
    } finally {
      setBusy(false);
    }
  };
  const deleteAccount = async () => {
    setBusy(true);
    try {
      const res = await fetch(apiPath, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not delete account." }));
        showToast((error as string) || "Could not delete account.");
        return;
      }
      showToast(`${accountLabel} account deleted.`);
      onRefresh();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-start gap-x-8 gap-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Account</p>
        <StatusPill active={row.active} />
        {row.joinedAt ? (
          <span className="text-xs text-muted">
            Joined {formatPacificDate(row.joinedAt, { year: "numeric", month: "short", day: "numeric" })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className={`rounded-full ${row.active ? "border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]" : ""}`}
          onClick={() => toggle()}
          disabled={busy}
        >
          {busy && !confirmDelete ? "Updating…" : row.active ? "Disable account" : "Enable account"}
        </Button>
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 portal-banner-danger">
            <span className="text-xs font-semibold text-rose-800">
              {apiPath === "/api/admin/residents"
                ? "Permanently delete this resident, leases, payments, and login?"
                : apiPath === "/api/admin/vendors"
                  ? "Delete vendor bids, invoices, and payouts?"
                  : "Delete permanently?"}
            </span>
            <button
              type="button"
              className="rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              onClick={() => void deleteAccount()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Yes, delete"}
            </button>
            <button
              type="button"
              className="text-xs font-semibold text-muted hover:text-foreground"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-rose-200 text-rose-700 hover:bg-[var(--status-overdue-bg)]"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            Delete account
          </Button>
        )}
      </div>
    </div>
  );
}

function ExpandedContent({
  row,
  onRefresh,
  showToast,
}: {
  row: UnifiedRow;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  if (row.kind === "manager") {
    return <ManagerAccountDetail row={row} onRefresh={onRefresh} showToast={showToast} />;
  }
  if (row.kind === "vendor") {
    return (
      <SimpleAccountDetailContent
        row={row}
        apiPath="/api/admin/vendors"
        accountLabel="Vendor"
        onRefresh={onRefresh}
        showToast={showToast}
      />
    );
  }
  return (
    <SimpleAccountDetailContent
      row={row}
      apiPath="/api/admin/residents"
      accountLabel="Resident"
      onRefresh={onRefresh}
      showToast={showToast}
    />
  );
}

export function AdminAxisUsersClient() {
  const { showToast } = useAppUi();
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [residents, setResidents] = useState<SimpleRow[]>([]);
  const [vendors, setVendors] = useState<SimpleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  // Category is the top-level tab, so it lives in the URL like every other
  // portal list tab — a staff member can link someone straight to Vendors.
  const searchParams = useSearchParams();
  const category = categoryFromParam(searchParams.get("category"));
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
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

  const load = useCallback(async () => {
    if (isDemoModeActive()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [mRes, rRes, vRes] = await Promise.all([
        fetch("/api/admin/managers"),
        fetch("/api/admin/residents"),
        fetch("/api/admin/vendors"),
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
    } catch {
      setLoadError("Could not reach the server. Check that Supabase env vars are configured.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

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
    const c = { management: 0, resident: 0, vendor: 0 };
    for (const row of unified) {
      if (row.kind === "resident") c.resident += 1;
      else if (row.kind === "vendor") c.vendor += 1;
      else c.management += 1;
    }
    return c;
  }, [unified]);

  const rowMatchesCategory = (row: UnifiedRow, cat: CategoryFilter) => {
    if (cat === "resident") return row.kind === "resident";
    if (cat === "vendor") return row.kind === "vendor";
    return row.kind === "manager";
  };

  const { activeCount, disabledCount } = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const row of unified) {
      if (!rowMatchesCategory(row, category)) continue;
      if (row.kind === "manager" && tierFilter !== "all" && row.tier.toLowerCase() !== tierFilter) continue;
      if (row.active) a += 1;
      else d += 1;
    }
    return { activeCount: a, disabledCount: d };
  }, [category, tierFilter, unified]);

  const visible = useMemo(() => {
    return unified.filter((row) => {
      if (statusTab === "active" && !row.active) return false;
      if (statusTab === "disabled" && row.active) return false;
      if (!rowMatchesCategory(row, category)) return false;
      if (row.kind === "manager" && tierFilter !== "all" && row.tier.toLowerCase() !== tierFilter) return false;
      return true;
    });
  }, [unified, statusTab, category, tierFilter]);

  const showTierFilter = category === "management";

  const STATUS_TABS: { id: StatusTab; label: string; count: number }[] = [
    { id: "active", label: "Active", count: activeCount },
    { id: "disabled", label: "Disabled", count: disabledCount },
  ];

  const ROLE_TABS = [
    { id: "management", label: "Management", count: categoryCounts.management },
    { id: "vendor", label: "Vendors", count: categoryCounts.vendor },
    { id: "resident", label: "Residents", count: categoryCounts.resident },
  ].map((tab) => ({
    ...tab,
    href: `/admin/axis-users?category=${tab.id}`,
    dataAttr: `admin-accounts-tab-${tab.id}`,
  }));

  const TIER_OPTIONS: { id: TierFilter; label: string }[] = [
    { id: "all", label: "All tiers" },
    { id: "free", label: "Free" },
    { id: "pro", label: "Pro" },
    { id: "business", label: "Business" },
  ];

  const selectedRows = visible.filter((row) => selectedIds.has(`${row.kind}-${row.id}`));

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
        onClick={() => setExpandedKey(`${selectedRows[0]!.kind}-${selectedRows[0]!.id}`)}
      >
        Open account
      </Button>
    ) : null;

  return (
    <ManagerPortalPageShell
      title="PropLane users"
      hideTitleOnMobileNav
      navigationProvidesTitle
      titleInlineFilter={null}
      compactFilterRow
    >
      {/*
        One command header — counted category tabs in a card, with the status
        and plan filters beside them — instead of three separately labelled
        pill groups stacked above the list. Same shape as every other portal.
      */}
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={ROLE_TABS}
        activeDestinationId={category}
        destinationAriaLabel="Account category"
        actions={
          <>
            <div className={PORTAL_TOOLBAR_GROUP}>
              {STATUS_TABS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setStatusTab(opt.id);
                    setExpandedKey(null);
                  }}
                  data-attr={`admin-accounts-status-${opt.id}`}
                  className={`${PORTAL_TOOLBAR_PILL_BUTTON} ${statusTab === opt.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : ""}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {showTierFilter ? (
              <div className={PORTAL_TOOLBAR_GROUP}>
                {TIER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setTierFilter(opt.id);
                      setExpandedKey(null);
                    }}
                    data-attr={`admin-accounts-tier-${opt.id}`}
                    className={`${PORTAL_TOOLBAR_PILL_BUTTON} ${tierFilter === opt.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : ""}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}
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
            const rowKey = `${row.kind}-${row.id}`;
            const isOpen = expandedKey === rowKey;
            return (
              <div key={rowKey}>
                <PortalPersonRecordRow
                  name={row.fullName || row.email}
                  subtitle={row.email}
                  meta={row.managerId || undefined}
                  selected={isOpen}
                  checked={selectedIds.has(rowKey)}
                  onSelectedChange={() => toggleSelected(rowKey)}
                  onOpen={() => setExpandedKey(isOpen ? null : rowKey)}
                  dataAttr="admin-account-row"
                  trailing={
                    <div className="flex shrink-0 items-center gap-2">
                      {row.kind === "manager" ? <TierBadge tier={row.tier} /> : null}
                      <StatusPill active={row.active} />
                    </div>
                  }
                />
                {isOpen ? (
                  <div className="border-b border-border/50 bg-accent/10 px-4 py-4">
                    <ExpandedContent
                      row={row}
                      onRefresh={() => {
                        setExpandedKey(null);
                        void load();
                      }}
                      showToast={showToast}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </PortalRecordListSurface>
      )}
    </ManagerPortalPageShell>
  );
}
