"use client";

import { PopupRecordPreview } from "@/components/portal/popup-live-preview";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";

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
 *
 * `variant="subordinate"` (C255) drops the card chrome and the large balance
 * headline for a single inline row — same Withdraw behavior, sized to sit
 * beside "Pay vendors" / "Plan & credit" without visually competing with
 * them, per the captain's "balance-spending actions the redesign wants to
 * encourage" note.
 */
export function ProplaneBalanceCard({
  portal,
  variant = "default",
}: {
  portal: ProplaneBalancePortalKind;
  variant?: "default" | "subordinate";
}) {
  const { showToast } = useAppUi();
  const apiBase = API_BASE[portal];
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null);
  const [snapshotScope, setSnapshotScope] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const [loadError, setLoadError] = useState(false);
  const [reading, setReading] = useState(true);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setReading(true);
    setLoadError(false);
    const result = await sharedGet(apiBase, { ttlMs: 0 });
    if (sequence !== loadSequence.current) return;
    const body = result.ok ? result.data as Partial<BalanceSnapshot> | null : null;
    if (!body || typeof body.enabled !== "boolean" || !Number.isSafeInteger(body.availableCents) ||
        !Number.isSafeInteger(body.pendingCents) || body.currency !== "usd") {
      setSnapshot(null);
      setSnapshotScope(apiBase);
      setLoadError(true);
      setReading(false);
      return;
    }
    setSnapshot(body as BalanceSnapshot);
    setSnapshotScope(apiBase);
    setReading(false);
  }, [apiBase]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  if (snapshotScope !== apiBase) return null;
  if (loadError) return <p role="alert" className="text-sm text-danger" data-attr="proplane-balance-read-error">Could not load PropLane balance.</p>;
  if (reading) return snapshot?.enabled ? <p role="status" className="text-sm text-muted">Checking PropLane balance…</p> : null;
  if (!snapshot?.enabled) return null;

  const amountCents = Math.round(Number(amount) * 100);
  const canSubmit = !loadError && Number.isFinite(amountCents) && amountCents > 0 && amountCents <= snapshot.availableCents;

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
      showToast(body.payoutPending
        ? "Withdrawal sent to your Stripe account. Bank payout needs a retry from Payouts."
        : "Withdrawal submitted.");
      setWithdrawOpen(false);
      setAmount("");
      invalidateSharedGets(apiBase);
      void load();
    } catch {
      showToast("Could not withdraw.");
    } finally {
      setSubmitting(false);
    }
  }

  const trigger =
    variant === "subordinate" ? (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-attr="proplane-balance-card-subordinate">
        <span className="text-muted">
          Balance:{" "}
          <span className="font-medium text-foreground" data-attr="proplane-balance-available">
            {formatMoney(snapshot.availableCents, snapshot.currency)}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setWithdrawOpen(true)}
          disabled={snapshot.availableCents <= 0}
          data-attr="proplane-balance-withdraw"
        >
          Withdraw
        </Button>
      </div>
    ) : (
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
      </div>
    );

  return (
    <>
      {trigger}

      <Modal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title="Withdraw from PropLane balance"
        contextPanel={<PopupRecordPreview rows={[{ label: "Available", value: formatMoney(snapshot.availableCents, snapshot.currency) }]} />}
        previewLabel="Withdrawal preview"
        preview={<PopupRecordPreview rows={[{ label: "Amount", value: Number.isFinite(amountCents) && amountCents > 0 ? formatMoney(amountCents, snapshot.currency) : "Not set" }, { label: "Destination", value: "Connected bank account" }]} />}
        footer={<ModalFooter><Button type="button" onClick={submitWithdraw} disabled={!canSubmit || submitting} data-attr="proplane-balance-withdraw-confirm">Withdraw</Button></ModalFooter>}
      >
        <div className="space-y-4 p-1">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-foreground">Amount</span>
            <input
              type="number"
              inputMode="decimal"
              required
              min="0.01"
              max={snapshot.availableCents / 100}
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

        </div>
      </Modal>
    </>
  );
}
