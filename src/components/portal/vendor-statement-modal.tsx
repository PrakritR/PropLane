"use client";

/**
 * VD54 — full ledger, month filter, reconciliation stamp, CSV export.
 * `/api/vendor/payouts/statement` is the one source: every charge/
 * platform_fee/hold/transfer/withdrawal/refund/adjustment line with a
 * running balance already computed server-side (statement.server.ts) —
 * never recomputed client-side.
 */
import { useEffect, useState } from "react";
import { Download, CheckCircle2 } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Select } from "@/components/ui/input";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

type StatementLine = {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  createdAt: string;
  runningBalanceCents: number;
};

type Statement = {
  lines: StatementLine[];
  reconciliation: { reconciledAt: string; matches: boolean } | null;
};

const KIND_LABEL: Record<string, string> = {
  charge: "Charge",
  platform_fee: "PropLane fee",
  hold: "Held",
  transfer: "Transfer",
  withdrawal: "Withdrawal",
  refund: "Refund",
  adjustment: "Adjustment",
};

function formatUsd(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [{ value: "", label: "All months" }];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    options.push({ value, label });
  }
  return options;
}

export function VendorStatementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [month, setMonth] = useState("");
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (month) params.set("month", month);
    fetch(`/api/vendor/payouts/statement?${params.toString()}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setStatement(body ?? { lines: [], reconciliation: null }))
      .finally(() => setLoading(false));
  }, [open, month]);

  const options = monthOptions();

  return (
    <PortalDialog open={open} onClose={onClose} title="Statement" size="wizard" dataAttr="vendor-statement-modal" primaryAction={null}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} data-attr="vendor-statement-month">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-3">
          {statement?.reconciliation ? (
            <span className="vbank-reconciled flex items-center gap-1.5 text-xs font-semibold text-[var(--pl-good,#1a9d5c)]" data-attr="vendor-statement-reconciled">
              <CheckCircle2 className="size-3.5" strokeWidth={2.5} />
              {statement.reconciliation.matches ? "Matches Stripe" : "Reconciling"} · last checked{" "}
              {new Date(statement.reconciliation.reconciledAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          ) : null}
          <PortalIconAction
            icon={Download}
            label="Export CSV"
            data-attr="vendor-statement-export"
            onClick={() => {
              const params = new URLSearchParams({ format: "csv" });
              if (month) params.set("month", month);
              window.open(`/api/vendor/payouts/statement?${params.toString()}`, "_blank", "noopener");
            }}
          />
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : !statement || statement.lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No activity yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted">
                <th className="py-2 pr-3">Date</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3 text-right">Amount</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines
                .slice()
                .reverse()
                .map((line) => (
                  <tr key={line.id} className="border-b border-border/60" data-attr="vendor-statement-row">
                    <td className="py-2 pr-3 text-muted">{new Date(line.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                    <td className="py-2 pr-3 text-foreground">{KIND_LABEL[line.kind] ?? line.kind}</td>
                    <td className="py-2 pr-3 text-foreground">{line.description}</td>
                    <td className={`py-2 pr-3 text-right font-medium ${line.amountCents < 0 ? "text-muted" : "text-foreground"}`}>
                      {formatUsd(line.amountCents)}
                    </td>
                    <td className="py-2 text-right font-semibold text-foreground">{formatUsd(line.runningBalanceCents)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </PortalDialog>
  );
}
