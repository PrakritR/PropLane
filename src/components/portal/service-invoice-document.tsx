"use client";

import { formatServiceMoney } from "@/lib/manager-service-workflow";

/** Labor + materials invoice block shared by the service record and Approve & pay. */
export function ServiceInvoiceDocument({
  laborCents,
  materialsCents,
  note,
  className,
}: {
  laborCents: number;
  materialsCents: number;
  note?: string | null;
  className?: string;
}) {
  const total = laborCents + materialsCents;
  if (total <= 0) return null;
  return (
    <div
      className={className ?? "rounded-xl border border-border bg-card p-3"}
      data-attr="service-invoice-document"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Invoice</p>
      <div className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted">Labor</span>
          <span className="font-medium tabular-nums">{formatServiceMoney(laborCents)}</span>
        </div>
        {materialsCents > 0 ? (
          <div className="flex justify-between gap-3">
            <span className="text-muted">Materials</span>
            <span className="font-medium tabular-nums">{formatServiceMoney(materialsCents)}</span>
          </div>
        ) : null}
        <div className="flex justify-between gap-3 border-t border-border pt-2 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatServiceMoney(total)}</span>
        </div>
      </div>
      {note?.trim() ? <p className="mt-2 text-xs text-muted">{note.trim()}</p> : null}
    </div>
  );
}
