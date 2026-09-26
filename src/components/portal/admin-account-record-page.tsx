"use client";

import { useState } from "react";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { Button } from "@/components/ui/button";
import { formatPacificDate } from "@/lib/pacific-time";
import { ManagerDangerZoneCard, ManagerPlanBillingCard } from "@/components/portal/admin-manager-account-detail";

/**
 * An Accounts row's record (C165): Overview / Plan & billing / Danger zone,
 * following the flat-cards shape `admin-property-record-page.tsx` (C163)
 * established — no side rail, since `record-sections.ts` is the shared
 * registry every kind but Residents still owes a real migration to
 * (`docs/agents/record-page.md`).
 */
export type AdminAccountRecordRow =
  | {
      kind: "manager";
      id: string;
      email: string;
      fullName: string;
      managerId: string;
      tier: string;
      active: boolean;
      joinedAt: string | null;
    }
  | {
      kind: "resident" | "vendor";
      id: string;
      email: string;
      fullName: string;
      managerId: string;
      active: boolean;
      joinedAt: string | null;
    };

const ROLE_LABEL: Record<AdminAccountRecordRow["kind"], string> = {
  manager: "Manager",
  resident: "Resident",
  vendor: "Vendor",
};

/**
 * Enable/disable and delete for a resident or vendor account — the simple
 * counterpart to {@link ManagerDangerZoneCard} (managers alone carry a plan
 * and billing overrides).
 */
function SimpleAccountDangerZoneCard({
  row,
  apiPath,
  accountLabel,
  onRefresh,
  showToast,
}: {
  row: { id: string; active: boolean };
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
      showToast(row.active ? `${accountLabel} account disabled.` : `${accountLabel} account enabled.`);
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
    <div className="flex flex-wrap items-center gap-2 px-4 py-4">
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
              : "Delete vendor bids, invoices, and payouts?"}
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
  );
}

export function AdminAccountRecordPage({
  row,
  backHref,
  planLabel,
  commsLabel,
  onRefresh,
  showToast,
}: {
  row: AdminAccountRecordRow;
  backHref: string;
  /** Manager rows only — the plan label the Overview and Plan & billing cards share. */
  planLabel?: string;
  /** Manager rows only — the wallet's remaining balance, already formatted. `undefined` on a free plan or unread wallet. */
  commsLabel?: string;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  const roleLabel = ROLE_LABEL[row.kind];

  return (
    <PortalRecordDetailPage
      title={row.fullName || row.email}
      subtitle={row.email}
      avatarName={row.fullName || row.email}
      backHref={backHref}
      backLabel="Accounts"
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <RecordFactCard title="Overview" dataAttr="admin-account-overview">
          <RecordFactRow label="Role" value={roleLabel} />
          {row.kind === "manager" ? <RecordFactRow label="Plan" value={planLabel ?? "—"} /> : null}
          <RecordFactRow label="Status" value={row.active ? "Active" : "Disabled"} tone={row.active ? "ok" : undefined} />
          <RecordFactRow label="PropLane ID" value={row.managerId || "—"} />
          <RecordFactRow
            label="Joined"
            value={
              row.joinedAt
                ? formatPacificDate(row.joinedAt, { year: "numeric", month: "short", day: "numeric" })
                : "—"
            }
          />
          {row.kind === "manager" ? <RecordFactRow label="Comms credit" value={commsLabel ?? "—"} /> : null}
        </RecordFactCard>

        {row.kind === "manager" ? (
          <RecordFactCard title="Plan & billing" dataAttr="admin-account-plan-billing">
            <ManagerPlanBillingCard row={row} onRefresh={onRefresh} showToast={showToast} />
          </RecordFactCard>
        ) : null}

        <RecordFactCard title="Danger zone" dataAttr="admin-account-danger-zone">
          {row.kind === "manager" ? (
            <ManagerDangerZoneCard row={row} onRefresh={onRefresh} showToast={showToast} />
          ) : (
            <SimpleAccountDangerZoneCard
              row={row}
              apiPath={row.kind === "resident" ? "/api/admin/residents" : "/api/admin/vendors"}
              accountLabel={roleLabel}
              onRefresh={onRefresh}
              showToast={showToast}
            />
          )}
        </RecordFactCard>
      </div>
    </PortalRecordDetailPage>
  );
}
