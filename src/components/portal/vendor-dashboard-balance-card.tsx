"use client";

/**
 * Vendor Dashboard's Balance card (captain, 2026-09-27) — the SAME balance
 * data source and withdraw flow the vendor's Payments page already uses
 * (`portal-payouts-settings-page.tsx`'s `/payouts/balance` + Withdraw sheet),
 * surfaced here too so a vendor can see what they're owed and pull it without
 * leaving Dashboard. No new money logic lives in this file.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpFromLine } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  formatMoney,
  isPortalPayoutBalance,
  type PortalPayoutBalance,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet } from "@/components/portal/payout-withdraw-sheet";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import {
  deriveVendorFinancesFigures,
  vendorWithdrawableCents,
  type VendorHeldReasonKind,
} from "@/lib/vendor-banking/finances";
import { track } from "@/lib/analytics/track-client";
import { sharedGet } from "@/lib/shared-get-cache";
import { isPayoutDestinationSummary, type PayoutDestinationSummary } from "@/components/portal/payout-bank-sheet";

const HELD_PHRASE: Record<VendorHeldReasonKind, string> = {
  none: "held",
  proplane: "held by PropLane",
  awaiting_bank: "held until you add a bank",
  awaiting_identity: "held until your identity is verified",
  releasing: "held, being released to your account",
};

export function VendorDashboardBalanceCard() {
  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [destinations, setDestinations] = useState<PayoutDestinationSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [addBankOpen, setAddBankOpen] = useState(false);

  const loadBalance = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const [balanceRead, banksRead] = await Promise.all([
      sharedGet("/api/vendor/payouts/balance", { ttlMs: 0 }),
      sharedGet("/api/vendor/stripe-connect/bank-accounts", { ttlMs: 0 }),
    ]);
    const bankBody = banksRead.ok ? banksRead.data as { destinations?: unknown } | null : null;
    if (!balanceRead.ok || !isPortalPayoutBalance(balanceRead.data) || !bankBody ||
        !Array.isArray(bankBody.destinations) || !bankBody.destinations.every(isPayoutDestinationSummary)) {
      setLoadError(true);
    } else {
      setBalance(balanceRead.data);
      setDestinations(bankBody.destinations);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  if (loading) return null;
  if (loadError || !balance || !destinations) return <div role="alert" className="rounded-xl border border-border p-4 text-sm" data-attr="vendor-dashboard-balance-error">Could not load payout funds or bank accounts.</div>;

  // The same derivation the Finances panel uses, so the two screens can never
  // disagree about what is withdrawable or what is held.
  const withdrawableCents = vendorWithdrawableCents(balance);
  const figures = deriveVendorFinancesFigures(balance);
  const withdrawAccounts = destinations.filter((row) => row.payable)
    .sort((a, b) => Number(b.default) - Number(a.default))
    .map((row) => ({ id: row.id, label: row.label, last4: row.last4, kind: row.kind, instantEligible: row.instantEligible }));
  const ready = balance.setup.ready && withdrawAccounts.length > 0;
  const heldCents = figures.heldCents;
  const heldLabel = `${HELD_PHRASE[figures.heldReasonKind]}${figures.hasDisputeFreeze ? " (Disputed)" : ""}`;
  return (
    <div className="rounded-[10px] border border-border bg-card px-4 py-3.5" data-attr="vendor-dashboard-balance">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-[550] text-muted">
            Available to withdraw
          </p>
          <p
            className="my-1 text-[26px] font-[650] leading-[1.15] tracking-[-0.03em] text-foreground"
            data-attr="vendor-dashboard-balance-available"
          >
            {formatMoney(withdrawableCents, balance.currency)}
          </p>
          {balance.onTheWayCents > 0 ? (
            <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-balance-pending">
              {formatMoney(balance.onTheWayCents, balance.currency)} on the way to your bank
            </p>
          ) : null}
          {balance.pendingCents > 0 ? <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-payment-pending">{formatMoney(balance.pendingCents, balance.currency)} pending payment</p> : null}
          {heldCents > 0 ? (
            <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-balance-held">
              {formatMoney(heldCents, balance.currency)} {heldLabel}
            </p>
          ) : null}
          {(balance.releasePendingCents ?? 0) > 0 ? <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-release-pending">{formatMoney(balance.releasePendingCents ?? 0, balance.currency)} release pending</p> : null}
          {(balance.withdrawableCents ?? 0) < 0 ? <p className="mt-1.5 text-xs text-danger" data-attr="vendor-dashboard-provider-deficit">Provider deficit {formatMoney(-(balance.withdrawableCents ?? 0), balance.currency)}</p> : null}
          {balance.payoutReconciliationPending ? <p className="mt-1.5 text-xs text-muted">Checking a prior withdrawal</p> : null}
        </div>
        <PortalIconAction
          icon={ArrowUpFromLine}
          label={ready ? "Withdraw" : "Add bank account"}
          data-attr="vendor-dashboard-withdraw"
          disabled={ready && (balance.payoutReconciliationPending || withdrawableCents <= 0)}
          onClick={() => {
            // No bank yet: the one Add bank account flow, never a Withdraw sheet
            // with nowhere to send the money.
            if (!ready) {
              setAddBankOpen(true);
              return;
            }
            track("payout_withdraw_started", { portal: "vendor", surface: "dashboard" });
            setWithdrawOpen(true);
          }}
        />
      </div>
      <AddBankFlow
        open={addBankOpen}
        onClose={() => setAddBankOpen(false)}
        portal="vendor"
        onAdded={() => {
          setAddBankOpen(false);
          void loadBalance();
        }}
      />
      <PayoutWithdrawSheet
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        apiBase="/api/vendor"
        currency={balance.currency}
        availableCents={withdrawableCents}
        instantAvailableCents={balance.instantAvailableCents}
        accounts={withdrawAccounts}
        onSuccess={(result) => {
          setWithdrawOpen(false);
          track("payout_withdraw_completed", {
            portal: "vendor",
            surface: "dashboard",
            method: result.method,
            amount_cents: result.amountCents,
          });
          void loadBalance();
        }}
      />
    </div>
  );
}
