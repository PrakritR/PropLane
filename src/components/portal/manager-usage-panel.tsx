"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  PortalSettingsDisclosureRow,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsScopeTag,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { formatPacificDate } from "@/lib/pacific-time";
import { formatUsdFromCents, COMMS_BILLING_METER_LABELS, type CommsBillingMeter } from "@/lib/comms-billing/rates";
import {
  COMMS_CREDIT_DEFAULT_CENTS,
  COMMS_CREDIT_MAX_CENTS,
  COMMS_CREDIT_MIN_CENTS,
  isValidCommsCreditAmountCents,
} from "@/lib/comms-billing/credit-packs";
import { pollUntilCreditPurchaseLands, useCreditCheckout } from "@/lib/comms-billing/use-credit-checkout";
import type { ManagerUsageSummary } from "@/app/api/manager/usage-summary/route";
import type { ManagerDoorCountPayload } from "@/app/api/manager/door-count/route";
import { RATE_CARD, priceForDoors, formatRateCardUsd, type RateCardTier, type RateCardBilling } from "@/lib/billing/rate-card";
import type { DoorCountBasis } from "@/lib/billing/door-count";

const ENDPOINT = "/api/manager/usage-summary";

function resetLabel(iso: string): string {
  return formatPacificDate(iso, { month: "short", day: "numeric" });
}

function percentOf(used: number, max: number | null): number {
  if (max === null || max <= 0) return 0;
  return Math.min(100, Math.max(0, (used / max) * 100));
}

function UsageBarRow({
  label,
  fact,
  primary,
  secondary,
  percent,
  dataAttr,
}: {
  label: string;
  fact?: string;
  primary: string;
  secondary?: string;
  percent: number;
  dataAttr?: string;
}) {
  return (
    <div className="border-b border-border px-4 py-3.5 last:border-0" data-attr={dataAttr}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
          {label}
          {fact ? <span className="text-[12.5px] font-normal text-muted">{fact}</span> : null}
        </span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{primary}</span>
      </div>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-accent/40" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      {secondary ? <p className="mt-1.5 text-xs tabular-nums text-muted">{secondary}</p> : null}
    </div>
  );
}

function useUsageSummary() {
  const [summary, setSummary] = useState<ManagerUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<ManagerUsageSummary | null> => {
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as ManagerUsageSummary & { error?: string };
      if (!res.ok) throw new Error(body.error || "We couldn't load your usage.");
      if (mounted.current) {
        setSummary(body);
        setError(null);
      }
      return body;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "We couldn't load your usage.");
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const id = window.setTimeout(() => void load(), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(id);
    };
  }, [load]);

  return { summary, error, load };
}

function useDoorCount() {
  const [data, setData] = useState<ManagerDoorCountPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<ManagerDoorCountPayload | null> => {
    try {
      const res = await fetch("/api/manager/door-count", { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as ManagerDoorCountPayload & { error?: string };
      if (!res.ok) throw new Error(body.error || "We couldn't load your door count.");
      if (mounted.current) {
        setData(body);
        setError(null);
      }
      return body;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "We couldn't load your door count.");
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const id = window.setTimeout(() => void load(), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(id);
    };
  }, [load]);

  return { data, error, load };
}

function doorTierName(tier: RateCardTier): string {
  if (tier === "free") return "Free";
  if (tier === "pro") return "Pro";
  return "Business";
}

/**
 * The honest "what it is" half of a breakdown row — derived from `basis`
 * alone (never a separate room count PropLane doesn't store), so it always
 * agrees with the `doors` figure printed right next to it:
 * "4 rooms · 4", "whole home · 1", "no rooms recorded · 1". Never says "0
 * rooms" — `doorCountForListing` never returns 0 doors, so neither does this.
 */
function doorBasisLabel(basis: DoorCountBasis, doors: number): string {
  if (basis === "whole-home") return "whole home";
  if (basis === "unrecorded") return "no rooms recorded";
  return `${doors} room${doors === 1 ? "" : "s"}`;
}

/**
 * Settings → Billing & plan → Doors. Per-door billing's headline: the
 * account's live door count against the tier's included allowance, what
 * pushing past it costs (`priceForDoors`, the one place that arithmetic
 * happens), and the per-listing breakdown a manager can add up to reach that
 * total. Reads the LIVE count (`GET /api/manager/door-count` →
 * `loadManagerDoorCount`) — never the frozen `manager_door_count_snapshots`
 * row a bill was actually issued against, so this can move between billing
 * periods as listings change; that is the point of showing it here rather
 * than only on the invoice.
 */
export function ManagerDoorsPanel({
  tier,
  billing,
  data,
  error,
  onRefresh,
}: {
  tier: RateCardTier;
  billing: RateCardBilling;
  data: ManagerDoorCountPayload | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const card = RATE_CARD[tier];
  const totalDoors = data?.totalDoors ?? 0;
  const remaining = Math.max(0, card.includedDoors - totalDoors);
  const overDoors = Math.max(0, totalDoors - card.includedDoors);
  const currentBillCents = (() => {
    try {
      return priceForDoors(tier, totalDoors, billing);
    } catch {
      // Free has no overage rate and is meant to be a hard cap; if an
      // account is somehow over it anyway, fall back to the floor rather
      // than crash the page a manager is reading their bill on.
      return billing === "annual" ? card.floorAnnualCents : card.floorMonthlyCents;
    }
  })();
  const billSuffix = billing === "annual" ? "/yr" : "/mo";

  return (
    <PortalSettingsSection title="Doors">
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => onRefresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
      ) : null}
      {data ? (
        <>
          <PortalSettingsGroup>
            <PortalSettingsRow label="Doors on your account">
              <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="doors-total">
                {totalDoors}
              </span>
            </PortalSettingsRow>
            <PortalSettingsRow label={`Included with ${doorTierName(tier)}`}>
              <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="doors-included">
                {card.includedDoors}
              </span>
            </PortalSettingsRow>
            <PortalSettingsRow label="Before the per-door rate applies">
              <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="doors-remaining">
                {overDoors > 0 ? `Over by ${overDoors}` : remaining}
              </span>
            </PortalSettingsRow>
            <PortalSettingsRow label="Current bill">
              <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="doors-current-bill">
                {formatRateCardUsd(currentBillCents)}
                {billSuffix}
              </span>
            </PortalSettingsRow>
          </PortalSettingsGroup>

          <PortalSettingsGroup>
            {data.breakdown.length === 0 ? (
              <p className="px-4 py-3.5 text-sm text-muted">No billable listings yet.</p>
            ) : (
              data.breakdown.map((row) => (
                <PortalSettingsRow key={row.propertyId} label={row.label}>
                  <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="doors-breakdown-row">
                    {doorBasisLabel(row.basis, row.doors)} · {row.doors}
                  </span>
                </PortalSettingsRow>
              ))
            )}
          </PortalSettingsGroup>
        </>
      ) : null}
    </PortalSettingsSection>
  );
}

/**
 * Settings → Billing & plan → Usage. Claude-style bars: label + fact on the
 * left, thin bar, "x of y" on the right, "Last updated" + refresh below.
 * Shares its data (and the poll after a credit purchase) with
 * `ManagerExtraUsagePanel` through the caller, which owns one `load()`.
 */
export function ManagerUsagePanel({
  summary,
  error,
  onRefresh,
}: {
  summary: ManagerUsageSummary | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <PortalSettingsSection
      title="Usage"
      action={summary ? <PortalSettingsScopeTag>{summary.tierLabel}</PortalSettingsScopeTag> : undefined}
    >
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => onRefresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {!summary && !error ? (
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
      ) : null}
      {summary ? (
        <>
          <PortalSettingsGroup>
            <UsageBarRow
              label="Communication"
              fact={`Resets ${resetLabel(summary.communication.resetsAt)}`}
              primary={
                summary.communication.paused ? "Paused" : `${formatUsdFromCents(summary.communication.remainingCents)} left`
              }
              secondary={`${formatUsdFromCents(summary.communication.includedUsedCents)} of ${formatUsdFromCents(summary.communication.includedAllowanceCents)}`}
              percent={percentOf(summary.communication.includedUsedCents, summary.communication.includedAllowanceCents)}
              dataAttr="usage-communication"
            />
            <UsageBarRow
              label="Property listings"
              primary={
                summary.listings.max === null
                  ? `${summary.listings.used}`
                  : `${summary.listings.used} of ${summary.listings.max}`
              }
              percent={percentOf(summary.listings.used, summary.listings.max)}
              dataAttr="usage-listings"
            />
            <UsageBarRow
              label="Workspaces"
              primary={`${summary.workspaces.used} of ${summary.workspaces.max}`}
              percent={percentOf(summary.workspaces.used, summary.workspaces.max)}
              dataAttr="usage-workspaces"
            />
            <UsageBarRow
              label="Work numbers"
              fact={summary.workNumbers.perWorkspace ? "1 per workspace" : undefined}
              primary={`${summary.workNumbers.used} of ${summary.workNumbers.max}`}
              percent={percentOf(summary.workNumbers.used, summary.workNumbers.max)}
              dataAttr="usage-work-numbers"
            />
            <UsageBarRow
              label="Co-managers"
              primary={
                summary.coManagers.max === null
                  ? `${summary.coManagers.used}`
                  : `${summary.coManagers.used} of ${summary.coManagers.max}`
              }
              percent={percentOf(summary.coManagers.used, summary.coManagers.max)}
              dataAttr="usage-co-managers"
            />
          </PortalSettingsGroup>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground disabled:opacity-50"
            data-attr="usage-refresh"
          >
            {refreshing ? "Updating…" : "Last updated: just now"}
            <span aria-hidden>↻</span>
          </button>
        </>
      ) : null}
    </PortalSettingsSection>
  );
}

/**
 * Settings → Billing & plan → Extra usage. A typed whole-dollar credit
 * purchase (not a fixed pack), the included-credit alert threshold as a
 * percent, and the usage-rates disclosure. Reads the same `summary` the Usage
 * panel above already fetched, and refetches it (`onPurchased`) once the
 * webhook-written wallet catches up with a purchase.
 */
export function ManagerExtraUsagePanel({
  summary,
  load,
}: {
  summary: ManagerUsageSummary | null;
  load: () => Promise<ManagerUsageSummary | null>;
}) {
  const { isNative } = useIsNativeApp();
  const { clientSecret, loading, error, checkout, reset } = useCreditCheckout();
  const [amountInput, setAmountInput] = useState(String(COMMS_CREDIT_DEFAULT_CENTS / 100));
  const [amountError, setAmountError] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [purchasePolling, setPurchasePolling] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
  // `alertOverride` is the stepper's in-progress edit; `null` means "show
  // what the server has", derived below rather than mirrored into state via
  // an effect (a `null` budget defaults to a sensible 80%).
  const [alertOverride, setAlertOverride] = useState<number | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertNotice, setAlertNotice] = useState<string | null>(null);
  const returnHandled = useRef(false);

  const serverAlertPercent = (() => {
    if (!summary) return 80;
    const allowance = Math.max(1, summary.communication.includedAllowanceCents);
    const pct = summary.monthlyBudgetCents == null ? 80 : Math.round((summary.monthlyBudgetCents / allowance) * 100);
    return Math.min(100, Math.max(1, pct));
  })();
  const alertPercent = alertOverride ?? serverAlertPercent;

  // Return from Stripe embedded checkout: poll the wallet (≤20s) until the
  // webhook-written purchase shows up, rather than assuming it landed.
  useEffect(() => {
    if (typeof window === "undefined" || returnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const purchaseId = params.get("comms_purchase");
    if (!purchaseId || !summary) return;
    returnHandled.current = true;
    const previous = summary.communication.purchasedRemainingCents;
    const id = window.setTimeout(() => {
      setPurchasePolling(true);
      void pollUntilCreditPurchaseLands({
        previousPurchasedRemainingCents: previous,
        load: async () => {
          const next = await load();
          return next ? { purchasedRemainingCents: next.communication.purchasedRemainingCents } : null;
        },
      }).then((landed) => {
        setPurchasePolling(false);
        setPurchaseNotice(
          landed
            ? "Credit added."
            : "Payment received. Your balance is still updating — refresh Usage in a moment.",
        );
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [summary, load]);

  const amountCents = (() => {
    const dollars = Number(amountInput);
    if (!Number.isFinite(dollars)) return null;
    return Math.round(dollars * 100);
  })();

  const buyCredit = async () => {
    setAmountError(null);
    if (amountCents === null || !isValidCommsCreditAmountCents(amountCents)) {
      setAmountError("Enter a whole-dollar amount from $5 to $500.");
      return;
    }
    setBuyOpen(true);
    await checkout(amountCents);
  };

  const closeBuy = () => {
    setBuyOpen(false);
    reset();
    void load();
  };

  const saveAlert = async () => {
    if (!summary) return;
    setAlertBusy(true);
    setAlertNotice(null);
    try {
      const cents = Math.round((summary.communication.includedAllowanceCents * alertPercent) / 100);
      const res = await fetch("/api/manager/comms-billing", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetCents: cents }),
      });
      if (!res.ok) {
        setAlertNotice("Could not save the alert threshold. Try again.");
        return;
      }
      setAlertNotice("Alert threshold saved.");
      await load();
      setAlertOverride(null);
    } catch {
      setAlertNotice("Could not save the alert threshold. Try again.");
    } finally {
      setAlertBusy(false);
    }
  };

  const paused = Boolean(summary?.communication.paused);
  const canBuy = isNative === false && !paused;

  return (
    <PortalSettingsSection title="Extra usage">
      <PortalSettingsGroup>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
            Communication credit
            <span className="text-[12.5px] font-normal text-muted">one-time · carries over</span>
          </span>
          {paused ? (
            <span className="text-sm font-medium text-muted" data-attr="extra-usage-paused">
              Paused
            </span>
          ) : canBuy ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5">
                <span className="text-sm text-muted">$</span>
                <input
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => {
                    setAmountInput(e.target.value);
                    setAmountError(null);
                  }}
                  className="w-14 bg-transparent text-sm font-semibold tabular-nums outline-none"
                  aria-label="Credit amount in dollars"
                  data-attr="extra-usage-credit-amount"
                />
              </div>
              <Button
                variant="outline"
                className="rounded-full text-[13px]"
                onClick={() => void buyCredit()}
                data-attr="extra-usage-buy"
              >
                {amountCents !== null && isValidCommsCreditAmountCents(amountCents)
                  ? `Buy $${amountCents / 100} more`
                  : "Buy"}
              </Button>
            </div>
          ) : (
            <span className="text-sm text-muted">Managed on the web</span>
          )}
        </div>
        {amountError ? (
          <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
            {amountError}
          </p>
        ) : null}
        {purchasePolling ? (
          <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted">
            Confirming your purchase…
          </p>
        ) : purchaseNotice ? (
          <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted" data-attr="extra-usage-purchase-notice">
            {purchaseNotice}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <span className="text-sm font-medium text-foreground">Alert me when included credit is at</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease alert threshold"
              disabled={alertBusy || alertPercent <= 1}
              onClick={() => setAlertOverride(Math.max(1, alertPercent - 1))}
              className="grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40"
            >
              <Minus className="size-4" aria-hidden />
            </button>
            <span className="w-10 text-center text-sm font-semibold tabular-nums" data-attr="extra-usage-alert-percent">
              {alertPercent}%
            </span>
            <button
              type="button"
              aria-label="Increase alert threshold"
              disabled={alertBusy || alertPercent >= 100}
              onClick={() => setAlertOverride(Math.min(100, alertPercent + 1))}
              className="grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40"
            >
              <Plus className="size-4" aria-hidden />
            </button>
            <Button variant="outline" className="rounded-full text-[13px]" disabled={alertBusy} onClick={() => void saveAlert()}>
              {alertBusy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {alertNotice ? (
          <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted">
            {alertNotice}
          </p>
        ) : null}

        <PortalSettingsDisclosureRow label="Usage rates" dataAttr="extra-usage-rates">
          <div className="space-y-0">
            {summary
              ? (Object.keys(summary.ratesCents) as CommsBillingMeter[]).map((meter) => (
                  <div key={meter} className="flex flex-wrap justify-between gap-3 border-t border-border py-2.5 text-sm first:border-t-0">
                    <span>{COMMS_BILLING_METER_LABELS[meter]}</span>
                    <span className="tabular-nums">
                      {summary.ratesCents[meter] === 0 ? "Included" : formatUsdFromCents(summary.ratesCents[meter])}
                    </span>
                  </div>
                ))
              : null}
          </div>
        </PortalSettingsDisclosureRow>
      </PortalSettingsGroup>

      <Modal open={buyOpen} title="Buy credit" onClose={closeBuy} assistantStrip={false} scrollableContent>
        {clientSecret ? (
          <EmbeddedCheckoutMount
            clientSecret={clientSecret}
            onError={() => {
              closeBuy();
            }}
          />
        ) : (
          <p className="py-8 text-center text-sm text-muted">{loading ? "Preparing secure checkout…" : "Starting checkout…"}</p>
        )}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {clientSecret ? (
          <Button variant="outline" className="mt-4" onClick={closeBuy}>
            Done · check balance
          </Button>
        ) : null}
      </Modal>
    </PortalSettingsSection>
  );
}

export { useUsageSummary, useDoorCount };
export const COMMS_CREDIT_AMOUNT_BOUNDS = { min: COMMS_CREDIT_MIN_CENTS, max: COMMS_CREDIT_MAX_CENTS };
