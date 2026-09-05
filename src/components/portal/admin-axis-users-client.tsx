"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AxisHeaderMarkTile } from "@/components/brand/axis-logo";
import {
  MANAGER_TABLE_TH,
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
  PORTAL_TOOLBAR_GROUP,
  PORTAL_TOOLBAR_LABEL,
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import { PORTAL_DATA_TABLE, PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DETAIL_BTN,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR_EXPANDABLE,
  PortalTableInlineExpand,
  createPortalRowExpandClick,} from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
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

type AccountKind = "manager" | "resident" | "vendor";

type UnifiedRow =
  | ({ kind: "manager" } & ManagerRow)
  | ({ kind: "resident" } & SimpleRow)
  | ({ kind: "vendor" } & SimpleRow);

type CategoryFilter = "management" | "resident" | "vendor";
type StatusTab = "active" | "disabled";
type TierFilter = "all" | "free" | "pro" | "business";
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

function UsersEmptyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
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

function RolePill({ kind }: { kind: AccountKind }) {
  const styles: Record<AccountKind, string> = {
    manager: "portal-badge-info border",
    resident: "portal-badge-info border",
    vendor: "portal-badge-info border",
  };
  const labels: Record<AccountKind, string> = {
    manager: "Management",
    resident: "Resident",
    vendor: "Vendor",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[kind]}`}>
      {labels[kind]}
    </span>
  );
}

/**
 * Staff's fee-payer choices. "inherit" is the absence of an override, not a fourth payer — it
 * hands the manager back to their own setting and their plan's rule.
 */
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
            <span className="text-xs font-semibold text-rose-800">
              Permanently delete this manager, all properties, residents, payments, and login?
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

function ManagerDetailRow({
  row,
  onRefresh,
  showToast,
}: {
  row: { kind: "manager" } & ManagerRow;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  return (
    <tr className={PORTAL_TABLE_DETAIL_ROW}>
      <td colSpan={3} className={PORTAL_TABLE_DETAIL_CELL}>
        <ManagerDetailContent row={row} onRefresh={onRefresh} showToast={showToast} />
      </td>
    </tr>
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

function SimpleAccountDetailRow({
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
  return (
    <tr className={PORTAL_TABLE_DETAIL_ROW}>
      <td colSpan={3} className={PORTAL_TABLE_DETAIL_CELL}>
        <SimpleAccountDetailContent
          row={row}
          apiPath={apiPath}
          accountLabel={accountLabel}
          onRefresh={onRefresh}
          showToast={showToast}
        />
      </td>
    </tr>
  );
}

function ExpandedRow({
  row,
  onRefresh,
  showToast,
}: {
  row: UnifiedRow;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  if (row.kind === "manager") {
    return <ManagerDetailRow row={row} onRefresh={onRefresh} showToast={showToast} />;
  }
  if (row.kind === "vendor") {
    return (
      <SimpleAccountDetailRow
        row={row}
        apiPath="/api/admin/vendors"
        accountLabel="Vendor"
        onRefresh={onRefresh}
        showToast={showToast}
      />
    );
  }
  return <SimpleAccountDetailRow row={row} apiPath="/api/admin/residents" accountLabel="Resident" onRefresh={onRefresh} showToast={showToast} />;
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
  const [category, setCategory] = useState<CategoryFilter>("management");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

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

  const ROLE_TABS: { id: CategoryFilter; label: string; count: number }[] = [
    { id: "management", label: "Management", count: categoryCounts.management },
    { id: "vendor", label: "Vendors", count: categoryCounts.vendor },
    { id: "resident", label: "Residents", count: categoryCounts.resident },
  ];

  const TIER_OPTIONS: { id: TierFilter; label: string }[] = [
    { id: "all", label: "All tiers" },
    { id: "free", label: "Free" },
    { id: "pro", label: "Pro" },
    { id: "business", label: "Business" },
  ];

  return (
    <ManagerPortalPageShell
      title="PropLane users"
      filterRow={
        <ManagerPortalFilterRow>
          <div>
            <p className={PORTAL_TOOLBAR_LABEL}>Category</p>
            <div className="mt-1.5">
              <ManagerPortalStatusPills
                tabs={ROLE_TABS}
                activeId={category}
                onChange={(id) => {
                  setCategory(id as CategoryFilter);
                  setExpandedKey(null);
                }}
              />
            </div>
          </div>
          <div>
            <p className={PORTAL_TOOLBAR_LABEL}>Status</p>
            <div className="mt-1.5">
              <ManagerPortalStatusPills
                tabs={STATUS_TABS}
                activeId={statusTab}
                onChange={(id) => {
                  setStatusTab(id as StatusTab);
                  setExpandedKey(null);
                }}
              />
            </div>
          </div>
          {showTierFilter ? (
            <div>
              <p className={PORTAL_TOOLBAR_LABEL}>Manager plan</p>
              <div className={`mt-1.5 ${PORTAL_TOOLBAR_GROUP}`}>
                {TIER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setTierFilter(opt.id);
                      setExpandedKey(null);
                    }}
                    className={`${PORTAL_TOOLBAR_PILL_BUTTON} ${tierFilter === opt.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : ""}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </ManagerPortalFilterRow>
      }
    >
      {loading ? (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-muted">Loading…</p>
          </div>
        </div>
      ) : loadError ? (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-rose-600">{loadError}</p>
            <button type="button" onClick={() => void load()} className="mt-3 text-xs font-semibold text-primary hover:underline">
              Try again
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className="flex flex-col items-center justify-center bg-accent/30/30 px-4 py-16 text-center sm:py-20">
            <AxisHeaderMarkTile>
              <UsersEmptyIcon className="h-[26px] w-[26px]" />
            </AxisHeaderMarkTile>
            <p className="mt-4 text-sm font-medium text-muted">
              {unified.length === 0 ? "No accounts yet" : "No accounts match these filters"}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {visible.map((row) => {
              const rowKey = `${row.kind}-${row.id}`;
              const isOpen = expandedKey === rowKey;
              return (
                <div key={rowKey} className={PORTAL_MOBILE_CARD_CLASS}>
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => setExpandedKey(isOpen ? null : rowKey)}
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-foreground">{row.fullName || row.email}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {row.kind === "manager" ? "Management" : row.kind === "vendor" ? "Vendor" : "Resident"}
                          {row.kind === "manager" ? ` · ${row.tier}` : ""}
                        </p>
                        {row.managerId ? (
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted/90">{row.managerId}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <StatusPill active={row.active} />
                      </div>
                    </div>
                  </button>
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="outline"
                      className={PORTAL_DETAIL_BTN}
                      onClick={() => setExpandedKey(isOpen ? null : rowKey)}
                    >
                      {isOpen ? "Less" : "Details"}
                    </Button>
                  </div>
                  {isOpen ? (
                    <div className="mt-3 border-t border-border pt-3">
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
          </div>
          <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Account</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Plan</th>
                    <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const rowKey = `${row.kind}-${row.id}`;
                    const isOpen = expandedKey === rowKey;
                    return (
                      <Fragment key={rowKey}>
                        <tr
                          className={PORTAL_TABLE_TR_EXPANDABLE}
                          onClick={createPortalRowExpandClick(() => setExpandedKey(isOpen ? null : rowKey))}
                          aria-expanded={isOpen}
                        >
                          <td className={PORTAL_TABLE_TD}>
                            <PortalTableInlineExpand expanded={isOpen} className="font-semibold text-foreground">
                              {row.fullName || row.email}
                            </PortalTableInlineExpand>
                            <p className="mt-0.5 text-sm text-muted">{row.email}</p>
                            {row.managerId ? (
                              <p className="mt-0.5 font-mono text-xs text-muted">{row.managerId}</p>
                            ) : null}
                          </td>
                          <td className={PORTAL_TABLE_TD}>
                            {row.kind === "manager" ? <TierBadge tier={row.tier} /> : <span className="text-sm text-muted">—</span>}
                          </td>
                          <td className={PORTAL_TABLE_TD}>
                            <StatusPill active={row.active} />
                          </td>
                        </tr>
                        {isOpen ? (
                          <ExpandedRow
                            row={row}
                            onRefresh={() => {
                              setExpandedKey(null);
                              void load();
                            }}
                            showToast={showToast}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </ManagerPortalPageShell>
  );
}
