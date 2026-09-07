"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { ManagerAccountDetail } from "@/components/portal/admin-manager-account-detail";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import {
  ADMIN_BILLING_TABS,
  adminBillingRowMatchesTab,
  adminBillingTabCounts,
  adminBillingTabFromParam,
  type AdminBillingRow,
} from "@/lib/admin-billing-rows";

/**
 * Admin → Billing: what each manager account is actually being held to.
 *
 * The same `PortalRecordListSurface` + `PortalPersonRecordRow` every other list tab in every other
 * portal uses — Billing is a different LENS on the accounts already in admin Accounts, not a new
 * kind of screen. Opening a row opens the SAME account editor Accounts opens
 * (`ManagerAccountDetail`), so a plan or override change is one control with one set of rules
 * wherever a staff member reaches it.
 *
 * The row never guesses. A plan the server could not read prints "Plan unknown" and prints nothing
 * derived from it — a cap, a fee payer or an allowance shown for an unknown plan would be a
 * confident wrong answer about somebody's money.
 */

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const FEE_PAYER_LABELS: Record<string, string> = {
  resident: "resident pays",
  manager: "manager pays",
  proplane: "PropLane absorbs",
};

function planBadgeClass(row: AdminBillingRow): string {
  if (row.planUnknown) return "border-amber-300 bg-amber-50 text-amber-800";
  if (row.tier === "pro" || row.tier === "business") return "portal-badge-info border";
  return "border-border bg-accent/30 text-muted";
}

/** The one-line billing summary under the account's name. */
export function adminBillingRowSummary(row: AdminBillingRow): string {
  const parts: string[] = [];

  if (row.planUnknown) {
    // Deliberately the only thing said about a row whose plan we could not read.
    parts.push("Plan unknown — could not read this account's plan");
    return parts.join(" · ");
  }

  parts.push(row.planLabel);
  if (row.onTrial) parts.push(row.trialEndsAt ? `trial ends ${row.trialEndsAt}` : "on trial");
  else if (row.trialLapsed) parts.push("trial lapsed");

  const used = row.listedCount === null ? "—" : String(row.listedCount);
  parts.push(
    row.propertyLimit === null
      ? `${used} listings (no cap)`
      : `${used} of ${row.propertyLimit} listings${row.propertyLimitIsOverride ? " (staff cap)" : ""}`,
  );

  if (row.serviceFeePayer) parts.push(FEE_PAYER_LABELS[row.serviceFeePayer] ?? row.serviceFeePayer);

  if (!row.comms) {
    // The allowance read is not available here; saying "$0.00 used" would read as a fact.
    parts.push("comms —");
  } else if (row.comms.allowanceCents === null) {
    parts.push(`comms ${formatUsdFromCents(row.comms.usedCents)} used`);
  } else {
    parts.push(
      `comms ${formatUsdFromCents(row.comms.usedCents)} of ${formatUsdFromCents(row.comms.allowanceCents)}`,
    );
  }

  return parts.join(" · ");
}

export function AdminBillingClient() {
  const { showToast } = useAppUi();
  const searchParams = useSearchParams();
  // The open tab IS the URL, like every other portal list tab, so "the accounts we absorb fees for"
  // is a link a staff member can send.
  const tab = adminBillingTabFromParam(searchParams.get("tab"));

  const [rows, setRows] = useState<AdminBillingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ tab: string; ids: Set<string> }>(() => ({
    tab: "all",
    ids: new Set(),
  }));
  const selectedIds = selection.tab === tab ? selection.ids : EMPTY_SELECTION;

  const toggleSelected = useCallback(
    (id: string) => {
      setSelection((prev) => {
        const base = prev.tab === tab ? prev.ids : EMPTY_SELECTION;
        const next = new Set(base);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { tab, ids: next };
      });
    },
    [tab],
  );

  const load = useCallback(async () => {
    if (isDemoModeActive()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/manager-billing");
      const json = (await res.json().catch(() => ({}))) as { rows?: AdminBillingRow[]; error?: string };
      if (!res.ok) {
        setLoadError(json.error ?? "Could not load billing.");
        return;
      }
      setRows(json.rows ?? []);
    } catch {
      setLoadError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const counts = useMemo(() => adminBillingTabCounts(rows), [rows]);
  const visible = useMemo(() => rows.filter((row) => adminBillingRowMatchesTab(row, tab)), [rows, tab]);

  const destinations = useMemo(
    () =>
      ADMIN_BILLING_TABS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        href: `/admin/billing?tab=${entry.id}`,
        count: counts[entry.id],
        dataAttr: `admin-billing-tab-${entry.id}`,
      })),
    [counts],
  );

  const selectedRows = visible.filter((row) => selectedIds.has(row.id));

  /**
   * One dock action: open the account. Plan, fees and the overrides all live inside that editor,
   * beside what they change — a cap or a comp flag is not something a stray tick should reach.
   */
  const bulkActions =
    selectedRows.length === 1 ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-billing-open"
        onClick={() => setExpandedId(selectedRows[0]!.id)}
      >
        Open account
      </Button>
    ) : null;

  return (
    <ManagerPortalPageShell
      title="Billing"
      subtitle="The plan, limits, processing fees and communication usage each manager account is actually held to."
      hideTitleOnMobileNav
      navigationProvidesTitle
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={destinations}
        activeDestinationId={tab}
        destinationAriaLabel="Billing status"
      />

      {loading ? (
        <PortalDataTableEmpty icon="data" message="Loading…" />
      ) : loadError ? (
        <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-danger">
          Could not load billing: {loadError}
          <button type="button" onClick={() => void load()} className="ml-2 font-semibold underline underline-offset-2">
            Try again
          </button>
        </div>
      ) : (
        <PortalRecordListSurface
          isEmpty={visible.length === 0}
          empty={
            <PortalDataTableEmpty
              icon="data"
              message={rows.length === 0 ? "No manager accounts yet" : "No accounts match this filter"}
            />
          }
          bulkCount={selectedRows.length}
          bulkActions={bulkActions}
          dataAttr="admin-billing-list"
        >
          {visible.map((row) => {
            const isOpen = expandedId === row.id;
            return (
              <div key={row.id}>
                <PortalPersonRecordRow
                  name={row.fullName || row.email}
                  subtitle={row.email}
                  preview={adminBillingRowSummary(row)}
                  meta={row.managerId || undefined}
                  selected={isOpen}
                  checked={selectedIds.has(row.id)}
                  onSelectedChange={() => toggleSelected(row.id)}
                  onOpen={() => setExpandedId(isOpen ? null : row.id)}
                  dataAttr="admin-billing-row"
                  trailing={
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {row.complimentary ? (
                        <span className="inline-flex items-center rounded-full border border-border bg-accent/30 px-2.5 py-1 text-xs font-semibold text-muted">
                          Comp
                        </span>
                      ) : null}
                      {row.atPropertyLimit ? (
                        <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold portal-badge-warning">
                          At cap
                        </span>
                      ) : null}
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${planBadgeClass(row)}`}
                        data-attr="admin-billing-plan-badge"
                      >
                        {row.planLabel}
                      </span>
                    </div>
                  }
                />
                {isOpen ? (
                  <div className="border-b border-border/50 bg-accent/10 px-4 py-4">
                    {/* The SAME editor admin Accounts opens — Billing is a lens, not a second
                        account screen. */}
                    <ManagerAccountDetail
                      row={{
                        id: row.id,
                        tier: row.storedTier,
                        active: row.active,
                        joinedAt: row.joinedAt,
                      }}
                      onRefresh={() => {
                        setExpandedId(null);
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
