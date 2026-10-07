"use client";

/**
 * "Refund a payment" (vendor-banking-1006): a payment, the amount (full or partial), a
 * reason, and a live preview - Manager gets back / PropLane fee returned to you / From your
 * balance. The preview is the same pure math the server uses (`refund-cap.ts`) but never
 * decides anything: the server recomputes every figure, caps the refund at what is
 * recoverable (held money plus the released balance still in the account) and refuses what
 * has already been withdrawn. The attempt key is minted per amount, so a retry or a
 * double-submit replays one refund on the central rail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { track } from "@/lib/analytics/track-client";
import { refundFeeShareCents, refundNetDebitCents } from "@/lib/vendor-banking/refund-cap";
import type { VendorPayout } from "@/lib/vendor-payouts";

export const VENDOR_REFUND_REASONS = [
  "Full refund",
  "Partial — materials returned",
  "Work not completed",
  "Duplicate payment",
  "Other",
] as const;

type RefundCapResponse = {
  enabled: boolean;
  payoutId: string;
  amountCents: number;
  platformFeeCents: number;
  refundedGrossCents: number;
  maxGrossCents: number;
  refusal: "fully_refunded" | "withdrawn" | "frozen" | null;
};

const REFUSAL_COPY = {
  fully_refunded: "This payment has already been fully refunded.",
  withdrawn: "This money has already been withdrawn, so it can't be refunded from here.",
  frozen: "This money is frozen by an open dispute.",
} as const;

function formatUsd(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function payoutLabel(payout: VendorPayout): string {
  const date = new Date(payout.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${formatUsd(payout.amountCents)} · ${date}`;
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function VendorRefundModal({
  open,
  onClose,
  onDone,
  initialPayoutId,
  paymentLabel,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** Opened from a payment's own ⋯ menu: that payment is preselected. */
  initialPayoutId?: string | null;
  /** The payment's name ("Patch drywall hole · $205.00") when the caller knows it. */
  paymentLabel?: string;
}) {
  const { showToast } = useAppUi();
  const [payouts, setPayouts] = useState<VendorPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [cap, setCap] = useState<RefundCapResponse | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState<string>(VENDOR_REFUND_REASONS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One attempt key per (payment, amount): a retry replays it, a changed amount is a new refund.
  const attempt = useRef<{ payoutId: string; amountCents: number; key: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/vendor/payouts", { credentials: "include" });
      const body = (await res.json().catch(() => null)) as { payouts?: VendorPayout[] } | null;
      const refundable = (body?.payouts ?? []).filter(
        (p) => (p.status === "paid" || p.status === "partially_refunded") && p.amountCents - (p.refundedGrossCents ?? 0) > 0,
      );
      setPayouts(refundable);
      setSelectedId((initialPayoutId && refundable.some((p) => p.id === initialPayoutId) ? initialPayoutId : refundable[0]?.id) ?? "");
    } finally {
      setLoading(false);
    }
  }, [initialPayoutId]);

  useEffect(() => {
    if (!open) return;
    setReason(VENDOR_REFUND_REASONS[0]);
    setError(null);
    attempt.current = null;
    void load();
  }, [open, load]);

  // The cap is the server's: held + released balance, never a client number.
  useEffect(() => {
    if (!open || !selectedId) {
      setCap(null);
      return;
    }
    let cancelled = false;
    setCap(null);
    fetch(`/api/vendor/payouts/${selectedId}/refund`, { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<RefundCapResponse>) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setCap(body);
        setAmountInput((body.maxGrossCents / 100).toFixed(2));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

  const selected = payouts.find((p) => p.id === selectedId) ?? null;

  const preview = useMemo(() => {
    if (!cap) return null;
    const requested = Math.round((Number(amountInput) || 0) * 100);
    const gross = Math.max(0, Math.min(requested, cap.maxGrossCents));
    const payout = { amountCents: cap.amountCents, platformFeeCents: cap.platformFeeCents, refundedGrossCents: cap.refundedGrossCents };
    return {
      gross,
      requested,
      feeShare: refundFeeShareCents(payout, gross),
      netDebit: refundNetDebitCents(payout, gross),
      over: requested > cap.maxGrossCents,
    };
  }, [cap, amountInput]);

  async function submit() {
    if (!selected || !preview || preview.gross <= 0 || preview.over) return;
    if (!attempt.current || attempt.current.payoutId !== selected.id || attempt.current.amountCents !== preview.gross) {
      attempt.current = { payoutId: selected.id, amountCents: preview.gross, key: newKey() };
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendor/payouts/${selected.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: JSON.stringify({ amountCents: preview.gross, reason }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; status?: string };
      if (!res.ok) {
        // A refund Stripe failed is over: the next try is a new one.
        if (body.code === "REFUND_FAILED" || body.code === "REFUND_REFUSED") attempt.current = null;
        throw new Error(body.error ?? "Could not process the refund.");
      }
      track("vendor_payout_refunded", { payout_id: selected.id, amount_cents: preview.gross });
      showToast(body.status === "pending" ? "Refund started." : "Refund sent.");
      onDone();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not process the refund.";
      setError(message);
      showToast(message);
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = cap?.refusal ? REFUSAL_COPY[cap.refusal] : null;

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Refund a payment"
      dataAttr="vendor-refund-modal"
      primaryAction={{
        label: submitting ? "Refunding…" : preview ? `Refund ${formatUsd(preview.gross)}` : "Refund",
        onClick: () => void submit(),
        disabled: !selected || !preview || preview.gross <= 0 || preview.over || submitting || Boolean(blocked),
        loading: submitting,
        dataAttr: "vendor-refund-submit",
      }}
    >
      {loading ? (
        <p className="text-sm text-muted">Loading payments…</p>
      ) : payouts.length === 0 ? (
        <p className="text-sm text-muted">No payments are eligible for a refund right now.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Payment</span>
            {payouts.length === 1 || initialPayoutId ? (
              <span className="text-sm text-foreground" data-attr="vendor-refund-payment">
                {paymentLabel && selected?.id === initialPayoutId ? paymentLabel : selected ? payoutLabel(selected) : ""}
              </span>
            ) : (
              <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} data-attr="vendor-refund-payment-select">
                {payouts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {payoutLabel(p)}
                  </option>
                ))}
              </Select>
            )}
          </label>
          {blocked ? (
            <p className="rounded-lg border border-border bg-accent/40 p-3 text-sm text-foreground" data-attr="vendor-refund-blocked">
              {blocked}
            </p>
          ) : (
            <>
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
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">Reason</span>
                <Select value={reason} onChange={(e) => setReason(e.target.value)} data-attr="vendor-refund-reason">
                  {VENDOR_REFUND_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </label>
              {preview && preview.gross > 0 ? (
                <div className="rounded-lg border border-border bg-accent/30 p-3 text-sm" data-attr="vendor-refund-preview">
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted">Manager gets back</span>
                    <span className="font-medium text-foreground">{formatUsd(preview.gross)}</span>
                  </div>
                  {preview.feeShare > 0 ? (
                    <div className="flex justify-between py-0.5">
                      <span className="text-muted">{PROPLANE_SERVICE_FEE_LABEL} returned to you</span>
                      <span className="font-medium text-foreground">{formatUsd(preview.feeShare)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between py-0.5">
                    <span className="text-muted">From your balance</span>
                    <span className="font-semibold text-foreground">{formatUsd(preview.netDebit)}</span>
                  </div>
                </div>
              ) : null}
              {cap ? (
                <p className="text-sm text-muted" data-attr="vendor-refund-cap">
                  You can refund up to {formatUsd(cap.maxGrossCents)} — the money still held for this job plus your available
                  balance.
                </p>
              ) : null}
            </>
          )}
          {error ? (
            <p className="text-sm text-[var(--status-overdue-fg)]" role="alert" data-attr="vendor-refund-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </PortalDialog>
  );
}
