"use client";
import { useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { bankToWithdrawAccounts, type PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
export function FinancesWithdrawAction() {
  const { showToast } = useAppUi();
  const [snapshot, setSnapshot] = useState<PortalPayoutBalance | null>(null);
  const [accounts, setAccounts] = useState<PayoutWithdrawAccount[]>([]);
  const [open, setOpen] = useState(false); const [loading, setLoading] = useState(false);
  async function launch() {
    if (loading) return; setLoading(true);
    try {
      const res = await fetch("/api/stripe/payouts/balance"); const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load withdrawals.");
      const banks = await fetch("/api/stripe/connect/bank-accounts");
      const bankBody = banks.ok ? await banks.json() : null;
      const destinations = bankBody?.destinations;
      setSnapshot(body);
      setAccounts(Array.isArray(destinations) ? [...destinations].sort((a,b) => Number(b.default) - Number(a.default)).map(row => ({ id: row.id, label: row.label, last4: row.last4, kind: row.kind, instantEligible: row.instantEligible })) : bankToWithdrawAccounts(body.bank));
      setOpen(true);
    } catch (error) { showToast(error instanceof Error ? error.message : "Could not load withdrawals."); } finally { setLoading(false); }
  }
  return <><PortalIconAction icon={ArrowDownToLine} label="Withdraw" disabled={loading} onClick={() => void launch()} />{snapshot ? <PayoutWithdrawSheet open={open} onClose={() => setOpen(false)} apiBase="/api/stripe" currency={snapshot.currency} availableCents={withdrawableCentsFromSnapshot(snapshot)} instantAvailableCents={snapshot.instantAvailableCents} heldDepositCents={snapshot.heldDepositCents} accounts={accounts} onSuccess={() => { setOpen(false); window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT)); }} /> : null}</>;
}
