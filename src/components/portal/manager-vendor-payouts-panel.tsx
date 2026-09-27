"use client";

/**
 * N004: manager-side aggregate payout report — every `vendor_payouts` row
 * across this manager's own vendors, read-only. Reachable from the Vendors
 * area via a "Payouts" icon action in `pro-vendors-panel.tsx`. No pill/badge
 * for status (AGENTS.md "no pills on rows") — plain text next to the row.
 */
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { formatPacificDateTime } from "@/lib/pacific-time";
import type { ManagerVendorPayoutReportRow } from "@/app/api/manager/vendor-payouts/route";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<ManagerVendorPayoutReportRow["status"], string> = {
  paid: "Paid",
  pending: "Pending",
  failed: "Failed",
  skipped: "Skipped",
};

export function ManagerVendorPayoutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<ManagerVendorPayoutReportRow[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState("loading");
    fetch("/api/manager/vendor-payouts", { credentials: "include" })
      .then((res) => res.json())
      .then((data: { rows?: ManagerVendorPayoutReportRow[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setState("error");
          return;
        }
        setRows(data.rows ?? []);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal open={open} title="Vendor payouts" onClose={onClose} panelClassName="max-w-2xl" dense>
      <div className="space-y-3 text-sm" data-attr="manager-vendor-payouts-panel">
        <p className="text-[13px] text-muted">
          Every payout PropLane has attempted on your behalf, across every vendor. Fee tracking isn&apos;t built yet —
          shown as &ldquo;—&rdquo; below.
        </p>
        {state === "loading" || state === "idle" ? (
          <p className="py-8 text-center text-sm text-muted">Loading payouts…</p>
        ) : state === "error" ? (
          <p className="py-8 text-center text-sm text-destructive">Could not load the payout report.</p>
        ) : !rows || rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No vendor payouts yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border" data-attr="manager-vendor-payout-row">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{row.vendorName}</p>
                  <p className="truncate text-[13px] text-muted">{row.workOrderReference || row.workOrderId}</p>
                  <p className="text-[13px] text-muted">{formatPacificDateTime(row.createdAt)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <strong className="block text-[13.5px]">{money(row.amountCents)}</strong>
                  <span className="text-[13px] text-muted">{STATUS_LABEL[row.status]}</span>
                  <span className="block text-[13px] text-muted">Fee —</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
