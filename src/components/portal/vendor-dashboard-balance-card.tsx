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
  bankToWithdrawAccounts,
  formatMoney,
  type PortalPayoutBalance,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet } from "@/components/portal/payout-withdraw-sheet";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { track } from "@/lib/analytics/track-client";

function isPayoutBalance(body: unknown): body is PortalPayoutBalance {
  return (
    Boolean(body) &&
    typeof body === "object" &&
    typeof (body as { availableCents?: unknown }).availableCents === "number" &&
    typeof (body as { currency?: unknown }).currency === "string" &&
    Boolean((body as { setup?: unknown }).setup)
  );
}

export function VendorDashboardBalanceCard() {
  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [addBankOpen, setAddBankOpen] = useState(false);

  const loadBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/payouts/balance", { credentials: "include" });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && isPayoutBalance(body)) {
        setBalance(body);
      }
    } catch {
      /* the card just stays hidden — Payments still has the full page */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  if (loading || !balance) return null;

  const withdrawableCents = withdrawableCentsFromSnapshot(balance);
  const ready = balance.setup.ready;
  const heldCents = balance.heldCents ?? 0;
  // The balance route only includes feeBps once vendor banking is on — the same
  // signal the Payments page uses to say "Available now" and "held by PropLane".
  const vendorBankingOn = typeof balance.feeBps === "number";

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm" data-attr="vendor-dashboard-balance">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            {vendorBankingOn ? "Available now" : "Balance"}
          </p>
          <p
            className="mt-1 text-[26px] font-extrabold leading-none tracking-tight text-foreground"
            data-attr="vendor-dashboard-balance-available"
          >
            {formatMoney(vendorBankingOn ? withdrawableCents : balance.availableCents, balance.currency)}
          </p>
          {balance.onTheWayCents > 0 ? (
            <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-balance-pending">
              {formatMoney(balance.onTheWayCents, balance.currency)} pending
            </p>
          ) : null}
          {vendorBankingOn && heldCents > 0 ? (
            <p className="mt-1.5 text-xs text-muted" data-attr="vendor-dashboard-balance-held">
              {formatMoney(heldCents, balance.currency)} held by PropLane
            </p>
          ) : null}
        </div>
        <PortalIconAction
          icon={ArrowUpFromLine}
          label="Withdraw"
          data-attr="vendor-dashboard-withdraw"
          disabled={ready && withdrawableCents <= 0}
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
        accounts={bankToWithdrawAccounts(balance.bank)}
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
