"use client";

import { useEffect, useMemo, useState } from "react";
import { CreditCard, Landmark } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import { cn } from "@/lib/utils";

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
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100);
}

const KEYPAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;

/**
 * Withdraw — the one investing-app-style sheet for moving money out (Screen
 * 2-4 of PLAN-0920-1500): a big amount (keypad on native/mobile, a plain
 * input on desktop), a "To" destination picker, Standard/Instant speed rows
 * that each say when the money lands and what it costs, a Continue step into
 * a plain-language Amount/Fee/Arrives/To confirmation, then one "Confirm
 * withdrawal" button. Replaces `PortalPayOutSheet`.
 *
 * The server re-reads the balance and re-checks Instant eligibility at
 * submit and is the only authority on the real fee/net/arrival — this sheet
 * previews the same 1% math so the numbers do not jump between preview and
 * confirmation (see `src/lib/stripe-payouts.ts`).
 */
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
}) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<"standard" | "instant">("standard");
  const [accountId, setAccountId] = useState("");
  const [step, setStep] = useState<"amount" | "confirm">("amount");
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    function measure() {
      setCompact(isNativeRuntimeSync() || (typeof window !== "undefined" && window.innerWidth < 640));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!open) return;
    const prefillCents = initialAmountCents ?? availableCents;
    setAmountInput(prefillCents > 0 ? (prefillCents / 100).toFixed(2) : "");
    setMethod(initialMethod ?? "standard");
    setAccountId(accounts[0]?.id ?? "");
    setStep("amount");
    setError(null);
    // Re-derive only when the sheet (re)opens or the prefill itself changes —
    // `availableCents` ticking on an unrelated balance refresh must not blow
    // away what the user is mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAmountCents, initialMethod]);

  const amountCents = parseDollarsToCents(amountInput);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0] ?? null;
  const previewFeeCents = method === "instant" ? Math.round(amountCents * 0.01) : 0;
  const netCents = Math.max(amountCents - previewFeeCents, 0);

  const belowMinimum = amountCents > 0 && amountCents < 100;
  const overBalance = amountCents > availableCents;
  const instantDisabledReason = !account?.instantEligible
    ? "Add a debit card for Instant"
    : amountCents > instantAvailableCents
      ? `Up to ${formatMoney(instantAvailableCents, currency)} now`
      : null;

  // Illustrative only — the server returns the real arrival date on create.
  const standardArrival = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }, []);

  function pressKey(key: (typeof KEYPAD_KEYS)[number]) {
    setAmountInput((current) => {
      if (key === "back") return current.slice(0, -1);
      if (key === ".") return current.includes(".") ? current : `${current || "0"}.`;
      if (/\.\d{2}$/.test(current)) return current;
      return current + key;
    });
  }

  function selectSpeed(next: "standard" | "instant") {
    if (next === "instant" && instantDisabledReason) return;
    setMethod(next);
  }

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
        setStep("amount");
        return;
      }
      onSuccess({
        payoutId: body.payoutId,
        amountCents: body.amountCents ?? amountCents,
        method: body.method ?? method,
      });
    } catch {
      setError("Could not withdraw.");
      setStep("amount");
    }
  }

  const accountLabel = account ? `${account.label} ····${account.last4}` : "Add a bank first";

  return (
    <Modal
      open={open}
      title="Withdraw"
      onClose={onClose}
      panelClassName="max-w-md"
      footer={
        <ModalFooter>
          {step === "amount" ? (
            <Button
              type="button"
              onClick={() => setStep("confirm")}
              disabled={continueDisabled}
              data-attr="withdraw-continue"
            >
              Continue
            </Button>
          ) : (
            <Button type="button" onClick={confirmWithdrawal} data-attr="withdraw-confirm">
              Confirm withdrawal
            </Button>
          )}
        </ModalFooter>
      }
    >
      {step === "amount" ? (
        <div className="space-y-5">
          <div className="text-center">
            <p
              className={cn("text-[44px] font-extrabold tracking-tight text-foreground", overBalance && "text-danger")}
              data-attr="withdraw-amount"
            >
              ${amountInput || "0"}
            </p>
            <p className="mt-1 text-xs text-muted" data-attr="withdraw-available-line">
              {formatMoney(availableCents, currency)} available ·{" "}
              <button
                type="button"
                className="font-semibold text-primary underline-offset-2 hover:underline"
                onClick={() => setAmountInput((availableCents / 100).toFixed(2))}
                data-attr="withdraw-max"
              >
                Max
              </button>
            </p>
          </div>

          {compact ? (
            <div className="grid grid-cols-3 gap-2" data-attr="withdraw-keypad">
              {KEYPAD_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => pressKey(key)}
                  aria-label={key === "back" ? "Delete" : key === "." ? "Decimal point" : key}
                  data-attr={`withdraw-key-${key === "back" ? "delete" : key === "." ? "dot" : key}`}
                  className="rounded-xl bg-accent/40 py-3.5 text-xl font-semibold text-foreground hover:bg-accent/60"
                >
                  {key === "back" ? "⌫" : key}
                </button>
              ))}
            </div>
          ) : (
            <input
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              aria-label="Amount"
              data-attr="withdraw-amount-input"
              className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-center text-lg font-semibold text-foreground outline-none"
            />
          )}

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">To</p>
            {accounts.length > 1 ? (
              <FieldSingleSelect
                label="To"
                value={accountId}
                options={accounts.map((a) => ({ value: a.id, label: `${a.label} ····${a.last4}` }))}
                onChange={setAccountId}
                dataAttr="withdraw-to"
              />
            ) : (
              <div
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                data-attr="withdraw-to"
              >
                {account?.kind === "card" ? (
                  <CreditCard className="size-5 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Landmark className="size-5 shrink-0 text-primary" aria-hidden />
                )}
                <p className="truncate text-sm font-semibold text-foreground">{accountLabel}</p>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">Speed</p>
            <div className="space-y-2">
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border px-3 py-2.5 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.04]">
                <input
                  type="radio"
                  name="withdraw-speed"
                  value="standard"
                  checked={method === "standard"}
                  onChange={() => selectSpeed("standard")}
                  className="size-4 shrink-0"
                  data-attr="withdraw-speed-standard"
                />
                <span className="text-sm text-foreground">
                  <b className="font-semibold">Standard</b> · 1–2 business days · free
                </span>
              </label>
              <label
                className={cn(
                  "flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5",
                  instantDisabledReason ? "opacity-50" : "has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.04]",
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <input
                    type="radio"
                    name="withdraw-speed"
                    value="instant"
                    checked={method === "instant"}
                    disabled={Boolean(instantDisabledReason)}
                    onChange={() => selectSpeed("instant")}
                    className="size-4 shrink-0"
                    data-attr="withdraw-speed-instant"
                  />
                  <span className="min-w-0 text-sm text-foreground">
                    <b className="font-semibold">Instant</b> · 30 minutes · 1% fee (min $0.50) · needs a debit card
                  </span>
                </span>
                {instantDisabledReason ? (
                  <span className="shrink-0 text-xs text-muted" data-attr="withdraw-instant-state">
                    {instantDisabledReason}
                  </span>
                ) : null}
              </label>
            </div>
          </div>

          {error ? (
            <p className="text-sm text-danger" role="alert" data-attr="withdraw-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4" data-attr="withdraw-confirm-step">
          <div className="space-y-2 rounded-xl bg-accent/40 px-4 py-3.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Amount</span>
              <b className="text-foreground" data-attr="withdraw-c-amount">
                {formatMoney(amountCents, currency)}
              </b>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Fee</span>
              <b className="text-foreground" data-attr="withdraw-c-fee">
                {formatMoney(previewFeeCents, currency)}
              </b>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Arrives</span>
              <b className="text-foreground" data-attr="withdraw-c-arrives">
                {method === "instant" ? "Within 30 minutes" : `${standardArrival}`}
              </b>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">To</span>
              <b className="text-foreground" data-attr="withdraw-c-to">
                {accountLabel}
              </b>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm">
            <span className="text-muted">Bank receives</span>
            <b className="text-foreground">{formatMoney(netCents, currency)}</b>
          </div>
          <button
            type="button"
            className="text-sm font-semibold text-primary underline-offset-2 hover:underline"
            onClick={() => setStep("amount")}
            data-attr="withdraw-back"
          >
            Back
          </button>
          {error ? (
            <p className="text-sm text-danger" role="alert" data-attr="withdraw-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
