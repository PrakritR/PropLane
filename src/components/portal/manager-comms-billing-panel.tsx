"use client";

import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { useCallback, useEffect, useRef, useState } from "react";
import { PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { COMMS_CREDIT_PACKS_CENTS } from "@/lib/comms-billing/credit-packs";
import {
  formatUsdFromCents,
  COMMS_BILLING_METER_LABELS,
  type CommsBillingMeter,
} from "@/lib/comms-billing/rates";
import type { ManagerCommsBillingSummary } from "@/lib/comms-billing/summary.server";

const ENDPOINT = "/api/manager/comms-billing";
export function ManagerCommsBillingPanel() {
  const { isNative } = useIsNativeApp();
  const [summary, setSummary] = useState<ManagerCommsBillingSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [pack, setPack] = useState<number>(1000);
  const [purchaseId, setPurchaseId] = useState<string | null>(null);
  const operation = useRef<{ id: string; amount: number } | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [budget, setBudget] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ENDPOINT, {
        credentials: "include",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.wallet)
        throw new Error(body.error || "We couldn’t load your balance.");
      if (!mounted.current) return;
      setSummary(body);
      setBudget(
        body.monthlyBudgetCents == null
          ? ""
          : String(body.monthlyBudgetCents / 100),
      );
      setError(null);
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "We couldn’t load your balance.",
        );
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const id = new URL(window.location.href).searchParams.get("comms_purchase");
    if (id)
      void Promise.resolve().then(() => {
        if (mounted.current) setPurchaseId(id);
      });
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function checkout() {
    if (checkoutLoading || isNative !== false) return;
    setCheckoutLoading(true);
    setCheckoutError(null);
    if (!operation.current || operation.current.amount !== pack)
      operation.current = { id: crypto.randomUUID(), amount: pack };
    try {
      const res = await fetch(`${ENDPOINT}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchaseId: operation.current.id,
          creditCents: pack,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.clientSecret)
        throw new Error(body.error || "Checkout could not be opened.");
      setClientSecret(body.clientSecret);
      setPurchaseId(body.purchaseId);
    } catch (e) {
      setCheckoutError(
        e instanceof Error ? e.message : "Checkout could not be opened.",
      );
    } finally {
      setCheckoutLoading(false);
    }
  }
  async function saveBudget() {
    const cents =
      budget.trim() === "" ? null : Math.round(Number(budget) * 100);
    if (
      cents !== null &&
      (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000)
    ) {
      setNotice("Enter an amount from $0 to $10,000.");
      return;
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetCents: cents }),
        credentials: "include",
      });
      if (!res.ok) {
        setNotice("Could not save budget alerts. Try again.");
        return;
      }
      setSummary(await res.json());
      setNotice("Budget alerts saved.");
    } catch {
      setNotice("Could not save budget alerts. Try again.");
    }
  }
  const close = () => {
    setBuyOpen(false);
    setClientSecret(null);
    setCheckoutError(null);
    operation.current = null;
    void load();
  };
  const payment = summary?.purchases.find((p) => p.id === purchaseId);
  const purchasesPaused = Boolean(
    summary && (!summary.paygEnabled || summary.billingPaused),
  );
  const canBuy = Boolean(summary && isNative === false && !purchasesPaused);
  const includedUsedCents = summary
    ? summary.wallet.allowanceCents - summary.wallet.includedRemainingCents
    : 0;
  const resetLabel = summary
    ? new Date(summary.periodEnd).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "";

  return (
    <PortalSettingsSection title="Communication credit">
      {loading && !summary ? (
        <div
          className="overflow-hidden rounded-2xl border border-border bg-card p-5"
          role="status"
        >
          <div className="h-4 w-24 animate-pulse rounded bg-accent" />
          <div className="mt-3 h-8 w-40 animate-pulse rounded bg-accent" />
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="space-y-3 overflow-hidden rounded-2xl border border-border bg-card p-5"
        >
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => load()}>
            Try again
          </Button>
        </div>
      ) : null}
      {summary && !error ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Remaining</p>
              <p
                className="mt-1 text-3xl font-semibold tracking-tight tabular-nums"
                data-attr="comms-available-credit"
              >
                {formatUsdFromCents(summary.wallet.remainingCents)}
              </p>
            </div>
            {canBuy ? (
              <Button
                data-attr="comms-buy-credit"
                disabled={loading}
                onClick={() => {
                  setBuyOpen(true);
                  setCheckoutError(null);
                }}
              >
                Buy credit
              </Button>
            ) : purchasesPaused ? (
              <span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted">
                Purchases paused
              </span>
            ) : null}
          </div>
          <div className="grid min-w-0 border-t border-border sm:grid-cols-2">
            <div className="p-5">
              <p className="text-sm font-semibold">Included this month</p>
              <progress
                className="my-3 h-2 w-full overflow-hidden rounded-full accent-primary"
                max={Math.max(summary.wallet.allowanceCents, 1)}
                value={includedUsedCents}
                aria-label="Included communication credit used"
              />
              <p className="text-sm tabular-nums">
                {formatUsdFromCents(includedUsedCents)} of{" "}
                {formatUsdFromCents(summary.wallet.allowanceCents)}
              </p>
            </div>
            <div className="border-t border-border p-5 sm:border-l sm:border-t-0">
              <p className="text-sm font-semibold">Purchased</p>
              <p className="mt-3 text-2xl font-semibold tabular-nums">
                {formatUsdFromCents(summary.wallet.purchasedRemainingCents)}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3.5 text-sm">
            <span className="font-medium">Resets</span>
            <strong>{resetLabel}</strong>
          </div>
          {summary.wallet.allowanceCents !==
          summary.wallet.nextAllowanceCents ? (
            <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3.5 text-sm">
              <span className="font-medium">Next month</span>
              <strong>
                {formatUsdFromCents(summary.wallet.nextAllowanceCents)}
              </strong>
            </div>
          ) : null}
          {purchaseId ? (
            <div
              className="space-y-2 border-t border-border px-5 py-3.5"
              role="status"
            >
              <p className="text-sm">
                {payment?.status === "paid"
                  ? payment.reversedCents > 0
                    ? `${formatUsdFromCents(payment.creditCents)} purchased; ${formatUsdFromCents(payment.reversedCents)} reversed.`
                    : `${formatUsdFromCents(payment.creditCents)} added.`
                  : payment?.status === "reversed"
                    ? "This purchase was reversed."
                    : "Payment confirmation is pending or checkout was canceled."}
              </p>
              <Button variant="outline" onClick={() => load()} disabled={loading}>
                Refresh balance
              </Button>
            </div>
          ) : null}
          <details className="border-t border-border text-sm">
            <summary className="cursor-pointer list-none px-5 py-3.5 font-medium [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-4">
                Usage rates
                <span aria-hidden>▸</span>
              </span>
            </summary>
            <div className="space-y-0 px-5 pb-4">
              {(Object.keys(summary.ratesCents) as CommsBillingMeter[]).map(
                (meter) => (
                  <div
                    key={meter}
                    className="flex flex-wrap justify-between gap-3 border-t border-border py-2.5"
                  >
                    <span>{COMMS_BILLING_METER_LABELS[meter]}</span>
                    <span className="tabular-nums">
                      {summary.ratesCents[meter] === 0
                        ? "Included"
                        : formatUsdFromCents(summary.ratesCents[meter])}
                    </span>
                  </div>
                ),
              )}
              {summary.meterTotals.length ? (
                summary.meterTotals.map((row) => (
                  <div
                    key={row.meter}
                    className="flex justify-between gap-3 border-t border-border py-2.5"
                  >
                    <span>
                      {row.label} × {row.quantity}
                    </span>
                    <span>{formatUsdFromCents(row.totalCents)}</span>
                  </div>
                ))
              ) : (
                <p className="border-t border-border py-2.5 text-muted">
                  No usage this month
                </p>
              )}
            </div>
          </details>
          <details className="border-t border-border text-sm">
            <summary className="cursor-pointer list-none px-5 py-3.5 font-medium [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-4">
                Purchases
                <span aria-hidden>▸</span>
              </span>
            </summary>
            <div className="px-5 pb-4">
              {summary.purchases.length ? (
                summary.purchases.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap justify-between gap-2 border-t border-border py-2.5"
                  >
                    <span>
                      {new Date(p.createdAt).toLocaleDateString()} ·{" "}
                      {formatUsdFromCents(p.creditCents)}
                    </span>
                    <span>
                      {p.status === "paid"
                        ? "Paid"
                        : p.status === "reversed"
                          ? "Reversed"
                          : "Awaiting payment"}
                      {p.reversedCents > 0
                        ? ` · ${formatUsdFromCents(p.reversedCents)} reversed`
                        : ""}
                    </span>
                  </div>
                ))
              ) : (
                <p className="border-t border-border py-2.5 text-muted">
                  No purchases
                </p>
              )}
            </div>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <label className="text-sm font-medium" htmlFor="comms-budget">
              Alert at
            </label>
            <div className="flex items-center gap-2">
              <input
                id="comms-budget"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="$"
                className="w-28 rounded-xl border border-border bg-background px-3 py-2"
              />
              <Button variant="outline" onClick={() => saveBudget()}>
                Save
              </Button>
            </div>
          </div>
          {notice ? (
            <p role="status" className="border-t border-border px-5 py-3 text-sm">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}
      <Modal
        open={buyOpen}
        title="Buy credit"
        onClose={close}
        assistantStrip={false}
        scrollableContent
      >
        {clientSecret ? (
          <EmbeddedCheckoutMount
            clientSecret={clientSecret}
            onError={setCheckoutError}
          />
        ) : (
          <div className="space-y-5">
            <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <legend className="sr-only">Credit amount</legend>
              {COMMS_CREDIT_PACKS_CENTS.map((amount) => (
                <label
                  key={amount}
                  className={`cursor-pointer rounded-xl border p-4 text-center text-sm font-bold ${
                    pack === amount
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border"
                  }`}
                >
                  <input
                    type="radio"
                    name="comms-credit-pack"
                    value={amount}
                    checked={pack === amount}
                    onChange={() => setPack(amount)}
                    disabled={checkoutLoading}
                    className="sr-only"
                  />
                  {formatUsdFromCents(amount)}
                </label>
              ))}
            </fieldset>
            <div className="flex justify-between border-y border-border py-4 text-sm">
              <span>Total</span>
              <strong>{formatUsdFromCents(pack)}</strong>
            </div>
            <Button
              onClick={() => checkout()}
              disabled={checkoutLoading}
              data-attr="comms-credit-checkout"
            >
              Continue to checkout
            </Button>
          </div>
        )}
        {checkoutError ? (
          <p role="alert" className="mt-4 text-sm text-danger">
            {checkoutError}
          </p>
        ) : null}
        {clientSecret ? (
          <Button variant="outline" className="mt-4" onClick={close}>
            Done · check balance
          </Button>
        ) : null}
      </Modal>
    </PortalSettingsSection>
  );
}
