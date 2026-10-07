"use client";

import { useEffect, useRef, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { computeInstantPayoutFeeCents } from "@/lib/stripe-payouts";

/** One live, owned, payable destination from the bank-accounts list. */
export type PayoutWithdrawAccount = {
  id: string;
  label: string;
  last4: string;
  kind: "bank" | "card";
  instantEligible: boolean;
};

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(
    cents / 100,
  );
}

function parseDollarsToCents(raw: string): number {
  const cleaned = raw.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(cleaned)) return 0;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

/** One confirmation; the server rechecks ownership, balance and destination before withdrawing. */
export function PayoutWithdrawSheet({
  open,
  onClose,
  apiBase,
  currency,
  availableCents,
  instantAvailableCents,
  accounts,
  onSuccess,
  initialAmountCents,
  initialMethod,
  instantFee,
}: {
  open: boolean;
  onClose: () => void;
  /** `/api/stripe` for a manager, `/api/vendor` for a vendor. */
  apiBase: string;
  currency: string;
  availableCents: number;
  instantAvailableCents: number;
  /** Exact payable rows from the owned live bank-accounts list. */
  accounts: PayoutWithdrawAccount[];
  onSuccess: (result: { payoutId: string; amountCents: number; method: "standard" | "instant" }) => void;
  /** Prefills the amount/speed — used to route a failed payout's Retry through this same sheet. */
  initialAmountCents?: number;
  initialMethod?: "standard" | "instant";
  /**
   * The Instant fee this surface is actually charged. Omitted, the shared 1%
   * Stripe-cost fee (managers). Vendors pass their one quote so the sheet shows
   * what the server takes — never a second, drifting number.
   */
  instantFee?: { label: string; quoteCents: (amountCents: number) => number };
}) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<"standard" | "instant">("standard");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Double-submit guard: a ref (not state) so two clicks in one frame cannot both pass.
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const prefillCents = initialAmountCents ?? availableCents;
    setAmountInput(prefillCents > 0 ? (prefillCents / 100).toFixed(2) : "");
    const first = accounts[0];
    setMethod(first?.kind === "card" ? "instant" : "standard");
    if (initialMethod === "instant" && first?.kind === "card" && first.instantEligible) setMethod("instant");
    setAccountId(first?.id ?? "");
    setError(null);
    submitting.current = false;
    setBusy(false);
    // Re-derive only when the sheet (re)opens or the prefill itself changes —
    // `availableCents` ticking on an unrelated balance refresh must not blow
    // away what the user is mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAmountCents, initialMethod]);

  const amountCents = parseDollarsToCents(amountInput);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const quoteInstantFee = instantFee?.quoteCents ?? computeInstantPayoutFeeCents;
  const previewFeeCents = method === "instant" ? quoteInstantFee(amountCents) : 0;
  const instantFeeLabel = instantFee?.label ?? "1% fee";
  const netCents = Math.max(amountCents - previewFeeCents, 0);

  const belowMinimum = amountCents > 0 && amountCents < 100;
  const overBalance = amountCents > availableCents;
  const standardAllowed = account?.kind === "bank";
  const instantDisabledReason = account?.kind !== "card" || !account.instantEligible
    ? "Add a debit card for Instant"
    : amountCents > instantAvailableCents
      ? `Up to ${formatMoney(instantAvailableCents, currency)} now`
      : null;

  const continueDisabled =
    amountCents <= 0 || belowMinimum || overBalance || !account ||
    (method === "standard" && !standardAllowed) ||
    (method === "instant" && Boolean(instantDisabledReason));

  async function confirmWithdrawal() {
    if (continueDisabled || !account?.id || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/payouts/create`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, method, destinationId: account.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        payoutId?: string;
        amountCents?: number;
        method?: "standard" | "instant";
        error?: string;
      };
      if (!res.ok || !body.payoutId) {
        setError(body.error ?? "Could not withdraw.");
        return;
      }
      onSuccess({
        payoutId: body.payoutId,
        amountCents: body.amountCents ?? amountCents,
        method: body.method ?? method,
      });
    } catch {
      setError("Could not withdraw.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <PortalDialog
      open={open}
      title="Withdraw"
      onClose={onClose}
      contextPanel={<PopupRecordPreview rows={[{ label: "Available", value: formatMoney(availableCents, currency) }, { label: "To", value: account ? `${account.label} ····${account.last4}` : "No account" }]} />}
      previewLabel="Withdrawal preview"
      preview={
        <PreviewPanel
          title="Withdrawal"
          name={formatMoney(amountCents, currency)}
          sub={account ? `${account.label} ····${account.last4}` : "No payout account"}
          facts={[
            { label: "Amount", value: amountCents > 0 ? formatMoney(amountCents, currency) : "Not set" },
            { label: "Speed", value: method === "instant" ? "Instant" : "Standard" },
            { label: "Arrives", value: method === "instant" ? "Within 30 minutes" : "1–2 business days" },
            { label: method === "instant" ? "Bank receives" : "Fee", value: method === "instant" ? formatMoney(netCents, currency) : "Free" },
          ]}
          creates={[
            { tone: overBalance || belowMinimum ? "warn" : "yes", text: overBalance ? "Amount is more than is available" : belowMinimum ? "Withdrawals start at $1.00" : "Sent to your payout account" },
          ]}
        />
      }
      primaryAction={{ label: `Withdraw ${formatMoney(amountCents, currency)}`, onClick: confirmWithdrawal, disabled: continueDisabled || !account || busy, dataAttr: "withdraw-confirm" }}>
      <div className="space-y-4">
        <label className="block text-sm font-medium">Amount
          <Input inputMode="decimal" value={amountInput} onChange={(event) => setAmountInput(event.target.value)} aria-label="Amount" data-attr="withdraw-amount-input" className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2" />
        </label>
        <div className="flex justify-between text-sm"><span>Available</span><button type="button" onClick={() => setAmountInput((availableCents / 100).toFixed(2))} aria-label="Max" data-attr="withdraw-max" className="text-primary">{formatMoney(availableCents, currency)}</button></div>
        <FieldSingleSelect label="To" value={account?.id ?? ""} onChange={(id) => {
          const next = accounts.find((candidate) => candidate.id === id);
          if (!next) return;
          setAccountId(id);
          setMethod(next.kind === "card" ? "instant" : "standard");
        }} options={accounts.map((item) => ({ value: item.id, label: `${item.label} ····${item.last4}` }))} />
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="withdraw-speed" checked={method === "standard"} disabled={!standardAllowed} onChange={() => setMethod("standard")} />Standard · free</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="withdraw-speed" checked={method === "instant"} disabled={Boolean(instantDisabledReason)} onChange={() => setMethod("instant")} />Instant · {instantFeeLabel}</label>
        {instantDisabledReason ? <p className="text-sm text-muted">{instantDisabledReason}</p> : null}
        <div className="flex justify-between text-sm"><span>Arrives</span><span>{method === "instant" ? "Within 30 minutes" : "1–2 business days"}</span></div>
        {method === "instant" ? <><div className="flex justify-between text-sm"><span>Fee</span><span>{formatMoney(previewFeeCents, currency)}</span></div><div className="flex justify-between text-sm"><span>Bank receives</span><span>{formatMoney(netCents, currency)}</span></div></> : null}
        {overBalance ? <p role="alert" className="text-sm text-danger">Amount exceeds available balance.</p> : null}
        {belowMinimum ? <p role="alert" className="text-sm text-danger">Enter at least $1.00.</p> : null}
        {error ? <p className="text-sm text-danger" role="alert" data-attr="withdraw-error">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}
