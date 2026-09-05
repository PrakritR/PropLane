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
import { Select } from "@/components/ui/input";
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
type ManagerPlan = "free" | "pro" | "business";

const MANAGER_PLAN_OPTIONS: { value: ManagerPlan; label: string }[] = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "business", label: "Business" },
];

function normalizeManagerPlan(tier: string): ManagerPlan {
  const t = tier.toLowerCase();
  if (t === "pro" || t === "business") return t;
  return "free";
}
function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold portal-badge-success">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-accent/30 px-2.5 py-1 text-xs font-semibold text-muted">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden />
      Disabled
    </span>
  );
}
function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    pro: "portal-badge-info border",
    business: "portal-badge-info border",
    free: "border-border bg-accent/30 text-muted",
  };
  const cls = colors[tier.toLowerCase()] ?? colors.free;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${cls}`}>
      {tier}
    </span>
  );
}

type FeeOverrideValue = "inherit" | "resident" | "manager" | "proplane";

const FEE_OVERRIDE_LABELS: Record<Exclude<FeeOverrideValue, "inherit">, string> = {
  resident: "the resident",
  manager: "the manager",
  proplane: "PropLane",
};

const FEE_OVERRIDE_OPTIONS: { value: FeeOverrideValue; label: string }[] = [
  { value: "inherit", label: "Manager's own setting" },
  { value: "resident", label: "Always resident" },
  { value: "manager", label: "Always manager" },
  { value: "proplane", label: "PropLane absorbs" },
];

const FEE_PAYER_LABELS: Record<string, string> = {
  resident: "the resident",
  manager: "the manager",
  proplane: "PropLane",
};

function ManagerDetailContent({
  row,
  onRefresh,
  showToast,
}: {
  row: { kind: "manager" } & ManagerRow;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [plan, setPlan] = useState<ManagerPlan>(() => normalizeManagerPlan(row.tier));
  const currentPlan = normalizeManagerPlan(row.tier);
  const planDirty = plan !== currentPlan;

  useEffect(() => {
    queueMicrotask(() => setPlan(normalizeManagerPlan(row.tier)));
  }, [row.tier]);

  // Who pays this manager's processing fees. Loaded per row rather than on the accounts list,
  // because it needs the manager's settings AND their plan — two reads each — and the list route
  // already pages every manager. This editor renders for one expanded row at a time.
  const [feeOverride, setFeeOverride] = useState<FeeOverrideValue>("inherit");
  const [effectivePayer, setEffectivePayer] = useState<string>("");
  const [feeBusy, setFeeBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/manager-service-fee?managerUserId=${encodeURIComponent(row.id)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { adminOverride?: string | null; effectivePayer?: string };
        if (cancelled) return;
        setFeeOverride((data.adminOverride as FeeOverrideValue) ?? "inherit");
        setEffectivePayer(data.effectivePayer ?? "");
      } catch {
        // Leave the control showing "inherit"; saving still works and re-reads the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  const saveFeeOverride = async (next: FeeOverrideValue) => {
    setFeeBusy(true);
    const previous = feeOverride;
    setFeeOverride(next);
    try {
      const res = await fetch("/api/admin/manager-service-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "inherit" is sent as null, which CLEARS the override and returns this manager to the
        // plan-and-choice rule — a different act from pinning "resident".
        body: JSON.stringify({ managerUserId: row.id, adminOverride: next === "inherit" ? null : next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; effectivePayer?: string };
      if (!res.ok) {
        setFeeOverride(previous);
        showToast(data.error || "Could not update processing fees.");
        return;
      }
      setEffectivePayer(data.effectivePayer ?? "");
      showToast(
        next === "inherit"
          ? "Processing fees follow the manager's own setting again."
          : `Processing fees now charged to ${FEE_OVERRIDE_LABELS[next]}.`,
      );
    } catch {
      setFeeOverride(previous);
      showToast("Could not update processing fees.");
    } finally {
      setFeeBusy(false);
    }
  };

  const savePlan = async () => {
    if (!planDirty) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, tier: plan }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not update plan." }));
        showToast((error as string) || "Could not update plan.");
        return;
      }
      showToast(`Plan updated to ${plan === "free" ? "Free" : plan === "pro" ? "Pro" : "Business"}.`);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, active: !row.active }),
      });
      if (!res.ok) {
        showToast("Could not update account.");
        return;
      }
      showToast(row.active ? "Manager account disabled." : "Manager account enabled.");
      onRefresh();
    } finally {
      setBusy(false);
    }
  };
  const deleteAccount = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not delete account." }));
        showToast((error as string) || "Could not delete account.");
        return;
      }
      showToast("Manager account deleted.");
      onRefresh();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Account</p>
        <TierBadge tier={row.tier} />
        <StatusPill active={row.active} />
        {row.joinedAt ? (
          <span className="text-xs text-muted">
            Joined {formatPacificDate(row.joinedAt, { year: "numeric", month: "short", day: "numeric" })}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Plan</p>
        <Select
          className="h-9 min-h-0 w-auto min-w-[8.5rem] rounded-full px-3 py-1.5 text-sm"
          value={plan}
          onChange={(e) => setPlan(e.target.value as ManagerPlan)}
          disabled={busy}
        >
          {MANAGER_PLAN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Processing fees</p>
        <Select
          className="h-9 min-h-0 w-auto min-w-[11rem] rounded-full px-3 py-1.5 text-sm"
          value={feeOverride}
          onChange={(e) => void saveFeeOverride(e.target.value as FeeOverrideValue)}
          disabled={feeBusy}
          aria-label="Who pays this manager's processing fees"
        >
          {FEE_OVERRIDE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
        {/* The NET answer, which can differ from the selection above: a free-tier manager who
            chose to absorb fees still cannot, and showing only the selection would disagree with
            what the resident is actually charged. */}
        {effectivePayer ? (
          <span className="text-xs text-muted">
            Currently paid by {FEE_PAYER_LABELS[effectivePayer] ?? effectivePayer}
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
          {busy && !confirmDelete && !planDirty ? "Updating…" : row.active ? "Disable account" : "Enable account"}
        </Button>
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 portal-banner-danger">
            <span className="text-xs font-semibold text-rose-800">Remove manager access and delete all properties?</span>
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

      <div className="ml-auto shrink-0">
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-full px-4 text-xs"
          onClick={() => savePlan()}
          disabled={busy || !planDirty}
        >
          {busy && planDirty ? "Saving…" : "Save plan"}
        </Button>
      </div>
    </div>
  );
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
                ? "Delete resident, leases, and payments?"
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
    return <ManagerDetailContent row={row} onRefresh={onRefresh} showToast={showToast} />;
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
