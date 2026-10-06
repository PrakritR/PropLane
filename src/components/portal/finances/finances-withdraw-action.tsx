"use client";
import { useState } from "react";
import { Landmark } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { isPortalPayoutBalance, type PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";
import { isPayoutDestinationSummary, type PayoutDestinationSummary } from "@/components/portal/payout-bank-sheet";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { sharedGet } from "@/lib/shared-get-cache";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
export function FinancesWithdrawAction() {
  const { showToast } = useAppUi();
  const [snapshot, setSnapshot] = useState<PortalPayoutBalance | null>(null);
  const [accounts, setAccounts] = useState<PayoutWithdrawAccount[]>([]);
  const [open, setOpen] = useState(false); const [addBankOpen, setAddBankOpen] = useState(false); const [loading, setLoading] = useState(false);
  async function launch() {
    if (loading) return;
    setLoading(true);
    setOpen(false);
    setSnapshot(null);
    try {
      const [balanceRead, banksRead] = await Promise.all([
        sharedGet("/api/stripe/payouts/balance", { ttlMs: 0 }),
        sharedGet("/api/stripe/connect/bank-accounts", { ttlMs: 0 }),
      ]);
      if (!balanceRead.ok || !isPortalPayoutBalance(balanceRead.data)) throw new Error("Could not load withdrawals.");
      const bankBody = banksRead.ok ? banksRead.data as { destinations?: unknown } | null : null;
      if (!bankBody || !Array.isArray(bankBody.destinations) ||
          !bankBody.destinations.every(isPayoutDestinationSummary)) {
        throw new Error("Could not verify payout bank accounts.");
      }
      const balance = balanceRead.data;
      const next: PayoutWithdrawAccount[] = (bankBody.destinations as PayoutDestinationSummary[])
        .filter((row) => row.payable)
        .sort((a, b) => Number(b.default) - Number(a.default))
        .map((row) => ({ id: row.id, label: row.label, last4: row.last4, kind: row.kind, instantEligible: row.instantEligible }));
      setSnapshot(balance);
      setAccounts(next);
      if (next.length === 0) setAddBankOpen(true);
      else if (balance.payoutReconciliationPending) showToast("Checking a prior withdrawal. Try again after reconciliation.");
      else if (withdrawableCentsFromSnapshot(balance) <= 0) showToast("No funds available to withdraw.");
      else setOpen(true);
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not load withdrawals."); } finally { setLoading(false); }
  }
  return <><AddBankFlow open={addBankOpen} onClose={() => setAddBankOpen(false)} portal="manager" onAdded={() => { setAddBankOpen(false); void launch(); }} /><PortalIconAction icon={Landmark} label="Withdraw" data-attr="finances-withdraw" disabled={loading} onClick={() => launch()} />{snapshot ? <PayoutWithdrawSheet open={open} onClose={() => setOpen(false)} apiBase="/api/stripe" currency={snapshot.currency} availableCents={withdrawableCentsFromSnapshot(snapshot)} instantAvailableCents={snapshot.instantAvailableCents} accounts={accounts} onSuccess={() => { setOpen(false); window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT)); }} /> : null}</>;
}
