"use client";

/**
 * VD50/VD51 — vendor-initiated refund of a payment they own. Picks a
 * refundable payment, full or partial amount, an optional reason, and a live
 * preview (manager gets back / your balance −, PropLane fee refunded) that
 * recomputes on every keystroke — pure client-side math mirroring
 * previewVendorRefund (src/lib/vendor-banking/refund.server.ts), which the
 * server re-derives and re-validates independently; this preview never
 * decides the real amount.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import type { VendorPayout } from "@/lib/vendor-payouts";

function formatUsd(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function refundableCents(payout: VendorPayout): number {
  return Math.max(0, payout.amountCents - (payout.refundedGrossCents ?? 0));
}

function payoutLabel(payout: VendorPayout): string {
  const date = new Date(payout.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${formatUsd(payout.amountCents)} · ${date}`;
}

export function VendorRefundModal({ open, onClose, feeBps, onDone }: { open: boolean; onClose: () => void; feeBps: number; onDone: () => void }) {
  const { showToast } = useAppUi();
  const [payouts, setPayouts] = useState<VendorPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shortfallNotice, setShortfallNotice] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/vendor/payouts", { credentials: "include" });
      const body = (await res.json().catch(() => null)) as { payouts?: VendorPayout[] } | null;
      const refundable = (body?.payouts ?? []).filter(
        (p) => (p.status === "paid" || p.status === "partially_refunded") && refundableCents(p) > 0,
      );
      setPayouts(refundable);
      setSelectedId(refundable[0]?.id ?? "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setReason("");
      setShortfallNotice(null);
      void load();
    }
  }, [open, load]);

  const selected = payouts.find((p) => p.id === selectedId) ?? null;
  const maxRefundable = selected ? refundableCents(selected) : 0;

  useEffect(() => {
    if (selected) setAmountInput((maxRefundable / 100).toFixed(2));
  }, [selectedId, maxRefundable, selected]);

  const preview = useMemo(() => {
    if (!selected) return null;
    const requestedCents = Math.round((Number(amountInput) || 0) * 100);
    const gross = Math.max(0, Math.min(requestedCents, maxRefundable));
    const feeShare = selected.amountCents > 0 ? Math.round((gross * (selected.platformFeeCents ?? 0)) / selected.amountCents) : 0;
    return { gross, feeShare, netDebit: Math.max(0, gross - feeShare) };
  }, [selected, amountInput, maxRefundable]);

  async function submit() {
    if (!selected || !preview || preview.gross <= 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/vendor/payouts/${selected.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `${selected.id}:${Date.now()}` },
        body: JSON.stringify({ amountCents: preview.gross, reason: reason.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; shortfallCents?: number };
      if (!res.ok) throw new Error(body.error ?? "Could not process the refund.");
      track("vendor_payout_refunded", { payout_id: selected.id, amount_cents: preview.gross });
      if (body.shortfallCents && body.shortfallCents > 0) {
        setShortfallNotice(body.shortfallCents);
      } else {
        showToast("Refund sent.");
        onDone();
        onClose();
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not process the refund.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Refund a payment"
      dataAttr="vendor-refund-modal"
      primaryAction={
        shortfallNotice
          ? { label: "Done", onClick: () => { onDone(); onClose(); }, dataAttr: "vendor-refund-done" }
          : {
              label: submitting ? "Refunding…" : preview ? `Refund ${formatUsd(preview.gross)}` : "Refund",
              onClick: () => void submit(),
              disabled: !selected || !preview || preview.gross <= 0 || submitting,
              loading: submitting,
              dataAttr: "vendor-refund-submit",
            }
      }
    >
      {loading ? (
        <p className="text-sm text-muted">Loading payments…</p>
      ) : payouts.length === 0 ? (
        <p className="text-sm text-muted">No payments are eligible for a refund right now.</p>
      ) : shortfallNotice ? (
        <div className="vbank-shortfall rounded-lg border border-border bg-accent/40 p-3 text-sm text-foreground">
          The manager has been refunded. Your balance couldn’t cover the full {formatUsd(shortfallNotice)} share right now, so
          it will be deducted from your next payments.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Payment</span>
            <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} data-attr="vendor-refund-payment-select">
              {payouts.map((p) => (
                <option key={p.id} value={p.id}>
                  {payoutLabel(p)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Amount</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              data-attr="vendor-refund-amount"
            />
            <span className="text-xs text-muted">Up to {formatUsd(maxRefundable)}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Reason (optional)</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} data-attr="vendor-refund-reason" />
          </label>
          {preview && preview.gross > 0 ? (
            <div className="rounded-lg border border-border bg-accent/30 p-3 text-sm" data-attr="vendor-refund-preview">
              <div className="flex justify-between py-0.5">
                <span className="text-muted">Manager gets back</span>
                <span className="font-medium text-foreground">{formatUsd(preview.gross)}</span>
              </div>
              {feeBps > 0 ? (
                <div className="flex justify-between py-0.5">
                  <span className="text-muted">PropLane fee refunded</span>
                  <span className="font-medium text-foreground">{formatUsd(preview.feeShare)}</span>
                </div>
              ) : null}
              <div className="flex justify-between py-0.5">
                <span className="text-muted">Your balance −</span>
                <span className="font-semibold text-foreground">{formatUsd(preview.netDebit)}</span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </PortalDialog>
  );
}
