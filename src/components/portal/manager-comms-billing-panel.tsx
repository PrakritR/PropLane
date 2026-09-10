"use client";

import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
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

  return (
    <PortalSettingsSection
      title="Communication credit"
      description="Your work number is included on every plan. Control what you spend on texts, calls and work-number AI."
    >
      {loading && !summary ? (
        <p role="status" className="text-sm text-muted">
          Loading communication balance…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">
            {error} Sending and purchases require a verified balance.
          </p>
          <Button variant="outline" onClick={() => load()}>
            Try again
          </Button>
        </div>
      ) : null}
      {summary && !error ? (
        <>
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Available communication credit"
              description={`${summary.wallet.tier[0].toUpperCase()}${summary.wallet.tier.slice(1)} plan`}
            >
              <div className="flex flex-wrap items-center gap-4">
                <p
                  className="text-3xl font-semibold tracking-tight tabular-nums"
                  data-attr="comms-available-credit"
                >
                  {formatUsdFromCents(summary.wallet.remainingCents)}{" "}
                  <span className="text-sm font-normal text-muted">
                    remaining
                  </span>
                </p>
                {isNative === false ? (
                  <Button
                    disabled={
                      !summary.paygEnabled || summary.billingPaused || loading
                    }
                    data-attr="comms-buy-credit"
                    onClick={() => {
                      setBuyOpen(true);
                      setCheckoutError(null);
                    }}
                  >
                    Buy more usage
                  </Button>
                ) : (
                  <p className="text-sm text-muted">
                    Additional credit purchases are not available in this app
                    yet.
                  </p>
                )}
              </div>
            </PortalSettingsRow>
            <div className="grid min-w-0 gap-6 p-5 sm:grid-cols-2">
              <div>
                <p className="text-sm font-semibold">Included this month</p>
                <progress
                  className="my-3 h-2 w-full overflow-hidden rounded-full accent-primary"
                  max={summary.wallet.allowanceCents}
                  value={
                    summary.wallet.allowanceCents -
                    summary.wallet.includedRemainingCents
                  }
                  aria-label="Included communication credit used"
                />
                <p className="text-sm tabular-nums">
                  {formatUsdFromCents(
                    summary.wallet.allowanceCents -
                      summary.wallet.includedRemainingCents,
                  )}{" "}
                  used of {formatUsdFromCents(summary.wallet.allowanceCents)}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Resets{" "}
                  {new Date(summary.periodEnd).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    timeZoneName: "short",
                  })}{" "}
                  (1st of the month, UTC).
                </p>
                {summary.wallet.allowanceCents !==
                summary.wallet.nextAllowanceCents ? (
                  <p className="mt-2 text-xs text-muted">
                    Your existing allowance is preserved this month. Next month:{" "}
                    {formatUsdFromCents(summary.wallet.nextAllowanceCents)}.
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-sm font-semibold">Purchased credit</p>
                <p className="my-3 text-2xl font-semibold tabular-nums">
                  {formatUsdFromCents(summary.wallet.purchasedRemainingCents)}
                </p>
                <p className="text-xs text-muted">
                  Carries forward. Used after included credit. No automatic
                  recharge.
                </p>
              </div>
            </div>
          </PortalSettingsGroup>
          {summary.blockMessage ? (
            <p
              role="status"
              className="rounded-xl border border-border bg-primary/5 p-3 text-sm"
            >
              {summary.blockMessage} Your number and message history remain
              available.
            </p>
          ) : summary.wallet.includedRemainingCents <=
            summary.wallet.allowanceCents * 0.2 ? (
            <p className="text-sm text-muted">
              You’ve used at least 80% of your included credit. Buy more to keep
              communication available.
            </p>
          ) : null}
          {!summary.paygEnabled ? (
            <p className="text-sm text-muted">
              Credit purchases are temporarily unavailable. Your existing
              balance is unchanged.
            </p>
          ) : null}
          {purchaseId ? (
            <div
              className="space-y-2 rounded-xl border border-border p-3"
              role="status"
            >
              <p className="text-sm">
                {payment?.status === "paid"
                  ? payment.reversedCents > 0 ? `${formatUsdFromCents(payment.creditCents)} purchased; ${formatUsdFromCents(payment.reversedCents)} reversed. Your balance reflects the adjustment.` : `${formatUsdFromCents(payment.creditCents)} communication credit added.`
                  : payment?.status === "reversed"
                    ? "This purchase was reversed. Your balance reflects the adjustment."
                    : "Payment confirmation is pending or checkout was canceled. Credit is added only after payment is verified."}
              </p>
              <Button
                variant="outline"
                onClick={() => load()}
                disabled={loading}
              >
                Refresh balance
              </Button>
            </div>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold">
              Usage rates and history
            </summary>
            <div className="mt-3 space-y-2">
              {(Object.keys(summary.ratesCents) as CommsBillingMeter[]).map(
                (meter) => (
                  <div
                    key={meter}
                    className="flex flex-wrap justify-between gap-3 border-b border-border py-2"
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
            </div>
            <p className="my-3 text-xs text-muted">
              Long or Unicode texts may use multiple billable segments. Voice
              speech recognition and recording are additional meters. Email and
              portal messages do not consume this credit.
            </p>
            {summary.meterTotals.length ? (
              summary.meterTotals.map((row) => (
                <p key={row.meter} className="flex justify-between gap-3 py-1">
                  <span>
                    {row.label} × {row.quantity}
                  </span>
                  <span>{formatUsdFromCents(row.totalCents)}</span>
                </p>
              ))
            ) : (
              <p className="text-muted">No usage recorded yet this month.</p>
            )}
            <p className="my-3 text-xs text-muted">
              Usage includes reservations while delivery is pending and
              unavoidable incoming usage that PropLane absorbs after your
              balance is exhausted.
            </p>
            <h3 className="mt-5 font-semibold">Recent credit purchases</h3>
            {summary.purchases.length ? (
              summary.purchases.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap justify-between gap-2 border-b border-border py-3"
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
              <p className="mt-2 text-muted">No credit purchases yet.</p>
            )}
          </details>
          <PortalSettingsGroup>
            <PortalSettingsRow
              label="Budget alerts"
              description="Alerts at 80% and 100%. This is an alert amount, not permission for automatic charges."
            >
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="comms-budget">
                  Monthly usage alert amount
                </label>
                <input
                  id="comms-budget"
                  inputMode="decimal"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="Optional amount"
                  className="w-36 rounded-xl border border-border bg-background px-3 py-2"
                />
                <Button variant="outline" onClick={() => saveBudget()}>
                  Save alerts
                </Button>
              </div>
            </PortalSettingsRow>
            {notice ? (
              <p role="status" className="text-sm text-muted">
                {notice}
              </p>
            ) : null}
          </PortalSettingsGroup>
        </>
      ) : null}
      <Modal
        open={buyOpen}
        title="Buy more usage"
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
            <p className="text-sm text-muted">
              Add credit for texts, calls and work-number AI without changing
              your plan.
            </p>
            <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <legend className="sr-only">Credit amount</legend>
              {COMMS_CREDIT_PACKS_CENTS.map((amount) => (
                <label
                  key={amount}
                  className={`cursor-pointer rounded-xl border p-4 text-center ${pack === amount ? "border-primary bg-primary/5" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="comms-credit-pack"
                    value={amount}
                    checked={pack === amount}
                    onChange={() => setPack(amount)}
                    disabled={checkoutLoading}
                    className="mr-2 accent-primary"
                  />
                  {formatUsdFromCents(amount)}
                </label>
              ))}
            </fieldset>
            <div className="flex justify-between border-y border-border py-4">
              <span>Total / communication credit</span>
              <strong>{formatUsdFromCents(pack)}</strong>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              One-time purchase. No automatic recharge. Unused purchased credit
              carries forward and is used after your monthly included credit.
            </p>
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
