"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";

export type ProplaneBalancePortalKind = "manager" | "vendor";

const API_BASE: Record<ProplaneBalancePortalKind, string> = {
  manager: "/api/portal/proplane-balance",
  vendor: "/api/vendor/proplane-balance",
};

type BalanceSnapshot = { enabled: boolean; availableCents: number; pendingCents: number; currency: string };

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(
    cents / 100,
  );
}

/**
 * "PropLane balance" — the internal platform-ledger balance from
 * night/vendor-pay (`PROPLANE_BALANCE_ENABLED`), separate from the
 * Stripe-Connect-derived balance `PortalPayoutsSettingsPage` already shows.
 * Renders nothing at all while the flag is off (`{ enabled: false }` from the
 * read route) or while nothing has loaded yet — this card is additive, never
 * a placeholder shown to every manager/vendor.
 */
export function ProplaneBalanceCard({ portal }: { portal: ProplaneBalancePortalKind }) {
  const { showToast } = useAppUi();
  const apiBase = API_BASE[portal];
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiBase, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as Partial<BalanceSnapshot>;
      if (res.ok) setSnapshot(body as BalanceSnapshot);
    } catch {
      // Silent — this card simply stays hidden if the read fails; it is
      // additive and never blocks the rest of the Payouts page.
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!snapshot?.enabled) return null;

  const amountCents = Math.round(Number(amount) * 100);
  const canSubmit = Number.isFinite(amountCents) && amountCents > 0 && amountCents <= snapshot.availableCents;

  async function submitWithdraw() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/withdraw`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; payoutPending?: boolean };
      if (!res.ok) {
        showToast(body.error ?? "Could not withdraw.");
        return;
      }
      track("proplane_balance_withdraw_submitted", { portal, amount_cents: amountCents });
      showToast(
        body.payoutPending
          ? "Withdrawal sent to your Stripe account — the automatic transfer to your bank needs a retry from Payouts."
          : "Withdrawal on its way to your bank.",
      );
      setWithdrawOpen(false);
      setAmount("");
      void load();
    } catch {
      showToast("Could not withdraw.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm" data-attr="proplane-balance-card">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">PropLane balance · Available</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4 max-md:flex-col max-md:items-stretch">
        <p className="text-[32px] font-extrabold leading-none tracking-tight text-foreground" data-attr="proplane-balance-available">
          {formatMoney(snapshot.availableCents, snapshot.currency)}
        </p>
        <Button
          type="button"
          onClick={() => setWithdrawOpen(true)}
          disabled={snapshot.availableCents <= 0}
          data-attr="proplane-balance-withdraw"
          className="max-md:w-full"
        >
          Withdraw
        </Button>
      </div>
      {snapshot.pendingCents > 0 ? (
        <p className="mt-2 text-xs text-muted" data-attr="proplane-balance-pending">
          {formatMoney(snapshot.pendingCents, snapshot.currency)} pending — not yet available to withdraw
        </p>
      ) : null}

      <Modal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title="Withdraw from PropLane balance">
        <div className="space-y-4 p-1">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">Amount</span>
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              data-attr="proplane-balance-withdraw-amount"
            />
          </label>
          <p className="text-xs text-muted">
            Up to {formatMoney(snapshot.availableCents, snapshot.currency)} available. Sent to your connected bank account.
          </p>
          <Button
            type="button"
            onClick={submitWithdraw}
            disabled={!canSubmit || submitting}
            data-attr="proplane-balance-withdraw-confirm"
            className="w-full"
          >
            Withdraw
          </Button>
        </div>
      </Modal>
    </div>
  );
}
