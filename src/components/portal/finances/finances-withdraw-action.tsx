"use client";
import { useState } from "react";
import { Landmark } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { bankToWithdrawAccounts, type PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
export function FinancesWithdrawAction() {
  const { showToast } = useAppUi();
  const [snapshot, setSnapshot] = useState<PortalPayoutBalance | null>(null);
  const [accounts, setAccounts] = useState<PayoutWithdrawAccount[]>([]);
  const [open, setOpen] = useState(false); const [addBankOpen, setAddBankOpen] = useState(false); const [loading, setLoading] = useState(false);
  async function launch() {
    if (loading) return; setLoading(true);
    try {
      const res = await fetch("/api/stripe/payouts/balance"); const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load withdrawals.");
      const banks = await fetch("/api/stripe/connect/bank-accounts");
      const bankBody = banks.ok ? await banks.json() : null;
      const destinations = bankBody?.destinations;
      setSnapshot(body);
      const next: PayoutWithdrawAccount[] = Array.isArray(destinations) ? [...destinations].sort((a,b) => Number(b.default) - Number(a.default)).map(row => ({ id: row.id, label: row.label, last4: row.last4, kind: row.kind, instantEligible: row.instantEligible })) : bankToWithdrawAccounts(body.bank);
      setAccounts(next);
      // No bank yet: the bank + flow is the fix, never a Withdraw sheet with nowhere to send money.
      if (next.length === 0) setAddBankOpen(true); else setOpen(true);
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not load withdrawals."); } finally { setLoading(false); }
  }
  return <><AddBankFlow open={addBankOpen} onClose={() => setAddBankOpen(false)} portal="manager" onAdded={() => { setAddBankOpen(false); void launch(); }} /><PortalIconAction icon={Landmark} label="Withdraw" data-attr="finances-withdraw" disabled={loading} onClick={() => void launch()} />{snapshot ? <PayoutWithdrawSheet open={open} onClose={() => setOpen(false)} apiBase="/api/stripe" currency={snapshot.currency} availableCents={withdrawableCentsFromSnapshot(snapshot)} instantAvailableCents={snapshot.instantAvailableCents} heldDepositCents={snapshot.heldDepositCents} accounts={accounts} onSuccess={() => { setOpen(false); window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT)); }} /> : null}</>;
}
