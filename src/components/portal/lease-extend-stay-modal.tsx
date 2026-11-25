"use client";
import { useState } from "react";
import { AddWorkspace } from "@/components/portal/add-workspace";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseClaimsExecution } from "@/lib/lease-execution-evidence";
import type { StayExtension } from "@/lib/lease-stay-extension.server";
import { stayDatePlus } from "@/lib/lease-stay-extension";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { invalidateSharedGets } from "@/lib/shared-get-cache";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export function LeaseExtendStayModal({ row, onClose, onSaved }: { row: LeasePipelineRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const [checkout, setCheckout] = useState("");
  const [quote, setQuote] = useState<{ extension: StayExtension; token?: string; saved?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(false);
  async function submit() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetchWithTimeout("/api/manager/extend-stay", { method: quote ? "POST" : "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leaseId: row.id, checkout, token: quote?.token }) }, 30_000);
      const body = await response.json();
      if (!response.ok) { if (response.status === 409) setQuote(null); throw new Error(body.error || "Could not extend this stay."); }
      if (!quote) { setQuote(body); return; }
      invalidateSharedGets();
      if (body.retryDelivery) { setRetry(true); setError(body.warning); return; }
      if (body.notification?.failed > 0) { setRetry(true); setError("Stay saved. The resident notice is queued for retry."); return; }
      await onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not extend this stay."); }
    finally { setBusy(false); }
  }
  return <AddWorkspace title="Extend stay" subtitle={row.residentName} steps={[{ id: "extension", label: "Dates & charges" }]} current={0} onJump={() => {}} onClose={onClose} assistantContext="Extend resident stay" assistantScopeKey="lease-extend-stay" lastLabel={retry ? "Retry delivery" : quote ? "Extend stay" : "Review extension"} lastDisabled={!checkout} busy={busy} onFinish={() => void submit()} dataAttrPrefix="lease-extend-stay" finishDataAttr="lease-extend-stay-confirm" footerNote={error ? <span role="alert" className="text-sm text-rose-600">{error}</span> : null}>
    <div className="mx-auto w-full max-w-xl space-y-6 p-6">
      <label className="block space-y-2"><span className="text-sm font-medium">New checkout date</span><input aria-label="New checkout date" type="date" disabled={busy || retry} value={checkout} onChange={(event) => { setCheckout(event.target.value); setQuote(null); setError(""); }} className="w-full rounded-md border border-border bg-background px-3 py-2" /></label>
      {quote ? <dl className="divide-y divide-border" data-attr="lease-extension-quote">
        <div className="flex justify-between gap-4 py-3"><dt>Current checkout</dt><dd>{stayDatePlus(quote.extension.previousEnd, 1)}</dd></div>
        <div className="flex justify-between gap-4 py-3"><dt>New checkout</dt><dd>{quote.extension.checkout}</dd></div>
        {quote.extension.lines.map((line) => <div key={`${line.key}:${line.start}`} className="flex justify-between gap-4 py-3"><dt>{line.label}</dt><dd className="shrink-0">{money(line.amountCents)}</dd></div>)}
        <div className="flex justify-between gap-4 py-3"><dt>Deposit change</dt><dd>$0.00</dd></div>
        <div className="flex justify-between gap-4 py-3 font-semibold"><dt>Added charges</dt><dd>{money(quote.extension.totalCents)}</dd></div>
        <div className="flex justify-between gap-4 py-3"><dt>Agreement</dt><dd>Extension record</dd></div>
        {leaseClaimsExecution(row) ? <div className="flex justify-between gap-4 py-3"><dt>Original signed document</dt><dd>Retained</dd></div> : null}
      </dl> : null}
    </div>
  </AddWorkspace>;
}
