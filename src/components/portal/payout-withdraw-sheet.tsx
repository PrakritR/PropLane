"use client";

import { useEffect, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { computeInstantPayoutFeeCents } from "@/lib/stripe-payouts";

/** One destination Withdraw can send money to — today's single bank/card, or a real row from the bank-accounts list once that route lands. */
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
  heldDepositCents = 0,
}: {
  open: boolean;
  onClose: () => void;
  /** `/api/stripe` for a manager, `/api/vendor` for a vendor. */
  apiBase: string;
  currency: string;
  availableCents: number;
  instantAvailableCents: number;
  /**
   * Destination accounts for the "To" picker, default-for-currency first —
   * real rows from `GET …/bank-accounts` when that route answers, or a
   * single synthesized entry from the balance's one bank/card as a fallback.
   * Picking one sends its id as `destinationId`; the server re-validates it
   * against the account's own live destination list.
   */
  accounts: PayoutWithdrawAccount[];
  onSuccess: (result: { payoutId: string; amountCents: number; method: "standard" | "instant" }) => void;
  /** Prefills the amount/speed — used to route a failed payout's Retry through this same sheet. */
  initialAmountCents?: number;
  initialMethod?: "standard" | "instant";
  heldDepositCents?: number;
}) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<"standard" | "instant">("standard");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const prefillCents = initialAmountCents ?? availableCents;
    setAmountInput(prefillCents > 0 ? (prefillCents / 100).toFixed(2) : "");
    setMethod(initialMethod ?? "standard");
    setAccountId(accounts[0]?.id ?? "");
    setError(null);
    // Re-derive only when the sheet (re)opens or the prefill itself changes —
    // `availableCents` ticking on an unrelated balance refresh must not blow
    // away what the user is mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAmountCents, initialMethod]);

  const amountCents = parseDollarsToCents(amountInput);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const previewFeeCents = method === "instant" ? computeInstantPayoutFeeCents(amountCents) : 0;
  const netCents = Math.max(amountCents - previewFeeCents, 0);

  const belowMinimum = amountCents > 0 && amountCents < 100;
  const overBalance = amountCents > availableCents;
  const instantDisabledReason = !account?.instantEligible
    ? "Add a debit card for Instant"
    : amountCents > instantAvailableCents
      ? `Up to ${formatMoney(instantAvailableCents, currency)} now`
      : null;

  const continueDisabled =
    amountCents <= 0 || belowMinimum || overBalance || (method === "instant" && Boolean(instantDisabledReason));

  async function confirmWithdrawal() {
    setError(null);
    try {
      // "default" is the synthetic single-entry fallback id
      // (`bankToWithdrawAccounts`) used only when the real bank-accounts
      // route is unavailable — never a real Stripe destination id, so it is
      // never sent; the server then falls back to the account's own default
      // external account, same as before `destinationId` existed.
      const destinationId = account && account.id !== "default" ? account.id : undefined;
      const res = await fetch(`${apiBase}/payouts/create`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, method, ...(destinationId ? { destinationId } : {}) }),
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
          sub={account ? `${account.label} ····${account.last4}` : "To your bank"}
          facts={[
            { label: "Amount", value: amountCents > 0 ? formatMoney(amountCents, currency) : "Not set" },
            { label: "Speed", value: method === "instant" ? "Instant" : "Standard" },
            { label: "Arrives", value: method === "instant" ? "Within 30 minutes" : "1–2 business days" },
            { label: method === "instant" ? "Bank receives" : "Fee", value: method === "instant" ? formatMoney(netCents, currency) : "Free" },
          ]}
          creates={[
            { tone: overBalance || belowMinimum ? "warn" : "yes", text: overBalance ? "Amount is more than is available" : belowMinimum ? "Withdrawals start at $1.00" : "Leaves your PropLane balance" },
            { tone: "no", text: "A receipt is emailed to you" },
          ]}
        />
      }
      primaryAction={{ label: `Withdraw ${formatMoney(amountCents, currency)}`, onClick: confirmWithdrawal, disabled: continueDisabled || !account, dataAttr: "withdraw-confirm" }}>
      <div className="space-y-4">
        <label className="block text-sm font-medium">Amount
          <Input inputMode="decimal" value={amountInput} onChange={(event) => setAmountInput(event.target.value)} aria-label="Amount" data-attr="withdraw-amount-input" className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2" />
        </label>
        <div className="flex justify-between text-sm"><span>Available</span><button type="button" onClick={() => setAmountInput((availableCents / 100).toFixed(2))} aria-label="Max" data-attr="withdraw-max" className="text-primary">{formatMoney(availableCents, currency)}</button></div>
        <FieldSingleSelect label="To" value={account?.id ?? ""} onChange={setAccountId} options={accounts.map((item) => ({ value: item.id, label: `${item.label} ····${item.last4}` }))} />
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="withdraw-speed" checked={method === "standard"} onChange={() => setMethod("standard")} />Standard · free</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="withdraw-speed" checked={method === "instant"} disabled={Boolean(instantDisabledReason)} onChange={() => setMethod("instant")} />Instant · 1% fee</label>
        {instantDisabledReason ? <p className="text-sm text-muted">{instantDisabledReason}</p> : null}
        <div className="flex justify-between text-sm"><span>Arrives</span><span>{method === "instant" ? "Within 30 minutes" : "1–2 business days"}</span></div>
        {method === "instant" ? <><div className="flex justify-between text-sm"><span>Fee</span><span>{formatMoney(previewFeeCents, currency)}</span></div><div className="flex justify-between text-sm"><span>Bank receives</span><span>{formatMoney(netCents, currency)}</span></div></> : null}
        {amountCents > Math.max(0, availableCents - heldDepositCents) && heldDepositCents > 0 ? <p role="status" className="text-sm text-foreground" data-attr="withdraw-held-deposits">Includes {formatMoney(Math.min(heldDepositCents, amountCents - Math.max(0, availableCents - heldDepositCents)), currency)} of held deposits</p> : null}
        {overBalance ? <p role="alert" className="text-sm text-danger">Amount exceeds available balance.</p> : null}
        {belowMinimum ? <p role="alert" className="text-sm text-danger">Enter at least $1.00.</p> : null}
        {error ? <p className="text-sm text-danger" role="alert" data-attr="withdraw-error">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}
