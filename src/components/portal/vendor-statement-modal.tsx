"use client";

/**
 * One month of the vendor statement: opening and closing balance, every ledger
 * line with its running balance, a reconciliation stamp, PDF (print) and CSV
 * export. `/api/vendor/payouts/statement` is the one source — every line, its
 * plain-language event type and its running balance are computed server-side
 * (statement.server.ts), never recomputed here. A failed read is an error with
 * Retry, never "No activity yet".
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, FileText } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import {
  statementMonthLabel,
  VENDOR_STATEMENT_EVENT_LABELS,
  type VendorStatementEventType,
} from "@/lib/vendor-banking/statement-events";
import { formatPacificDate } from "@/lib/pacific-time";

type StatementLine = {
  id: string;
  kind: string;
  eventType?: VendorStatementEventType;
  amountCents: number;
  description: string;
  createdAt: string;
  runningBalanceCents: number;
};

export type VendorStatementPayload = {
  lines: StatementLine[];
  openingCents: number;
  closingCents: number;
  reconciliation: { reconciledAt: string; matches: boolean } | null;
};

export function formatStatementUsd(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function VendorStatementModal({ open, onClose, month }: { open: boolean; onClose: () => void; month: string }) {
  const [statement, setStatement] = useState<VendorStatementPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`/api/vendor/payouts/statement?month=${encodeURIComponent(month)}`, { credentials: "include" });
      if (!res.ok) throw new Error("statement unavailable");
      setStatement((await res.json()) as VendorStatementPayload);
      setState("ready");
    } catch {
      setStatement(null);
      setState("error");
    }
  }, [month]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <PortalDialog open={open} onClose={onClose} title={statementMonthLabel(month)} size="wizard" dataAttr="vendor-statement-modal" primaryAction={null}>
      {state === "loading" ? (
        <p className="py-6 text-center text-sm text-muted" data-attr="vendor-statement-loading">Loading…</p>
      ) : state === "error" || !statement ? (
        <div className="flex flex-col items-center gap-3 py-6" role="alert" data-attr="vendor-statement-error">
          <p className="text-sm text-foreground">Could not load this statement.</p>
          <Button type="button" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-6 text-sm">
              <span>Opening <b data-attr="vendor-statement-opening">{formatStatementUsd(statement.openingCents)}</b></span>
              <span>Closing <b data-attr="vendor-statement-closing">{formatStatementUsd(statement.closingCents)}</b></span>
            </div>
            <div className="flex items-center gap-3">
              {statement.reconciliation ? (
                <span
                  className={`flex items-center gap-1.5 text-xs font-semibold ${statement.reconciliation.matches ? "text-[var(--pl-good,#1a9d5c)]" : "text-muted"}`}
                  data-attr="vendor-statement-reconciled"
                >
                  <CheckCircle2 className="size-3.5" strokeWidth={2.5} />
                  {statement.reconciliation.matches ? "Matches Stripe" : "Reconciling"} · checked{" "}
                  {new Date(statement.reconciliation.reconciledAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              ) : null}
              <PortalIconAction
                icon={FileText}
                label="Download PDF"
                data-attr="vendor-statement-pdf"
                onClick={() => window.open(`/print/vendor-statement/${encodeURIComponent(month)}`, "_blank", "noopener")}
              />
              <PortalIconAction
                icon={Download}
                label="Export CSV"
                data-attr="vendor-statement-export"
                onClick={() => window.open(`/api/vendor/payouts/statement?format=csv&month=${encodeURIComponent(month)}`, "_blank", "noopener")}
              />
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            {statement.lines.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No activity this month.</p>
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
                        <td className="py-2 pr-3 text-muted">
                          {formatPacificDate(line.createdAt, { month: "short", day: "numeric" })}
                        </td>
                        <td className="py-2 pr-3 text-foreground">
                          {line.eventType ? VENDOR_STATEMENT_EVENT_LABELS[line.eventType] : line.kind}
                        </td>
                        <td className="py-2 pr-3 text-foreground">{line.description}</td>
                        <td className={`py-2 pr-3 text-right font-medium ${line.amountCents < 0 ? "text-muted" : "text-foreground"}`}>
                          {formatStatementUsd(line.amountCents)}
                        </td>
                        <td className="py-2 text-right font-semibold text-foreground">{formatStatementUsd(line.runningBalanceCents)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </PortalDialog>
  );
}
