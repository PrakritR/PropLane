"use client";

import { useEffect, useMemo, useState } from "react";
import { Landmark } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PortalPayOutBank = {
  last4: string;
  bankName: string;
  accountType: string;
  instantEligible: boolean;
} | null;

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

function capitalize(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/**
 * Pay out — amount first (prefilled with everything available), the bank it
 * goes to, two speed rows that each say when the money lands and what it
 * costs, one review line, one button whose label carries the amount
 * (PLAN-0920-0853). The server re-reads the balance and the Instant cap at
 * submit and is the only authority on the actual fee/net/arrival — this sheet
 * previews the same 1% math so the numbers do not jump between preview and
 * confirmation.
 */
export function PortalPayOutSheet({
  open,
  onClose,
  apiBase,
  currency,
  availableCents,
  instantAvailableCents,
  bank,
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
  bank: PortalPayOutBank;
  onSuccess: (result: { payoutId: string; amountCents: number; method: "standard" | "instant" }) => void;
  /**
   * Prefills the amount/speed instead of "everything available" — used to
   * route a failed payout's Retry through this same confirmation sheet
   * rather than resubmitting silently. `stripe_payouts.amount_cents` always
   * holds the GROSS amount the user originally typed (`createInAppPayout`
   * never overwrites it with Stripe's net Instant `payout.amount`), so the
   * original row's `amountCents`/`method` can be handed straight through —
   * the server recomputes the fee fresh off that gross figure on submit.
   */
  initialAmountCents?: number;
  initialMethod?: "standard" | "instant";
}) {
  const [amountInput, setAmountInput] = useState("");
  const [method, setMethod] = useState<"standard" | "instant">("standard");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const prefillCents = initialAmountCents ?? availableCents;
    setAmountInput((prefillCents / 100).toFixed(2));
    setMethod(initialMethod ?? "standard");
    setError(null);
    // Re-derive only when the sheet (re)opens or the prefill itself changes —
    // `availableCents` ticking on an unrelated balance refresh must not blow
    // away what the user is mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAmountCents, initialMethod]);

  const amountCents = parseDollarsToCents(amountInput);
  const previewFeeCents = Math.round(amountCents * 0.01);
  const feeCents = method === "instant" ? previewFeeCents : 0;
  const netCents = Math.max(amountCents - feeCents, 0);

  const instantDisabledReason = !bank?.instantEligible
    ? "This bank cannot receive Instant payouts"
    : amountCents > instantAvailableCents
      ? `up to ${formatMoney(instantAvailableCents, currency)} now`
      : null;

  // Illustrative only — the server returns the real arrival date on create.
  const standardArrival = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }, []);

  const overBalance = amountCents <= 0 || amountCents > availableCents;
  const submitDisabled = overBalance || (method === "instant" && Boolean(instantDisabledReason)) || submitting;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/payouts/create`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, method }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        payoutId?: string;
        amountCents?: number;
        method?: "standard" | "instant";
        error?: string;
      };
      if (!res.ok || !body.payoutId) {
        setError(body.error ?? "Could not pay out.");
        return;
      }
      onSuccess({
        payoutId: body.payoutId,
        amountCents: body.amountCents ?? amountCents,
        method: body.method ?? method,
      });
    } catch {
      setError("Could not pay out.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Pay out"
      onClose={onClose}
      panelClassName="max-w-md"
      footer={
        <ModalFooter>
          <Button type="button" onClick={submit} disabled={submitDisabled} data-attr="pay-out-submit">
            {`Pay out ${formatMoney(amountCents, currency)}`}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">Amount</p>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-1 rounded-xl border border-border bg-card px-3 py-2.5">
              <span className="text-lg font-semibold text-muted">$</span>
              <input
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                aria-label="Amount"
                data-attr="pay-out-amount"
                className="w-full min-w-0 bg-transparent text-lg font-semibold text-foreground outline-none"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAmountInput((availableCents / 100).toFixed(2))}
              data-attr="pay-out-all"
            >
              All
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">To</p>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
            <Landmark className="size-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {bank ? `${bank.bankName} ····${bank.last4}` : "No bank linked"}
              </p>
              {bank ? <p className="truncate text-xs text-muted">{capitalize(bank.accountType)}</p> : null}
            </div>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted">Speed</p>
          <div className="space-y-2">
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border px-3 py-2.5 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.04]">
              <input
                type="radio"
                name="payout-speed"
                value="standard"
                checked={method === "standard"}
                onChange={() => setMethod("standard")}
                className="size-4 shrink-0"
              />
              <span className="text-sm text-foreground">
                <b className="font-semibold">Standard</b> · Free · arrives {standardArrival}
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
                  name="payout-speed"
                  value="instant"
                  checked={method === "instant"}
                  disabled={Boolean(instantDisabledReason)}
                  onChange={() => setMethod("instant")}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 text-sm text-foreground">
                  <b className="font-semibold">Instant</b> · {formatMoney(previewFeeCents, currency)} fee (1%) · arrives in
                  about 30 minutes
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted" data-attr="pay-out-instant-state">
                {instantDisabledReason ?? `up to ${formatMoney(instantAvailableCents, currency)} now`}
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-xl bg-accent/40 px-3 py-2.5 text-sm">
          <span className="text-muted">Bank receives</span>
          <b className="text-foreground" data-attr="pay-out-net">
            {formatMoney(netCents, currency)}
          </b>
        </div>

        {error ? (
          <p className="text-sm text-danger" role="alert" data-attr="pay-out-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
