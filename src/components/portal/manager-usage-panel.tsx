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
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";
import { useWorkspaces } from "@/components/portal/workspace-provider";
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
import type { ManagerDoorCountPayload } from "@/app/api/manager/door-count/route";
import type { ManagerUsageSummary } from "@/app/api/manager/usage-summary/route";
import { RATE_CARD, priceForResidents, formatRateCardUsd, includedResidentsForTier, type RateCardTier, type RateCardBilling } from "@/lib/billing/rate-card";

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
 * Settings → Billing & plan → Residents. Plan included residents + paid
 * extras, priced with the same floor + per-extra rate as the rate card
 * (`priceForResidents`). Metered on approved / manually-added residents,
 * not listing doors.
 */
export function ManagerDoorsPanel({
  tier,
  billing,
  used,
  max,
  error,
  onRefresh,
}: {
  tier: RateCardTier;
  billing: RateCardBilling;
  used: number | null;
  max: number | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const card = RATE_CARD[tier];
  const included = includedResidentsForTier(tier);
  const total = used ?? 0;
  const remaining = Math.max(0, included - total);
  const over = Math.max(0, total - included);
  const currentBillCents = (() => {
    try {
      return priceForResidents(tier, total, billing);
    } catch {
      return billing === "annual" ? card.floorAnnualCents : card.floorMonthlyCents;
    }
  })();
  const billSuffix = billing === "annual" ? "/yr" : "/mo";
  const capLabel = max == null ? `${total}` : `${total} of ${max}`;

  return (
    <PortalSettingsSection title="Residents">
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => onRefresh()}>
            Try again
          </Button>
        </div>
      ) : null}
      {used == null && !error ? (
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
      ) : null}
      {used != null ? (
        <PortalSettingsGroup>
          <PortalSettingsRow label="Residents on your account">
            <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="residents-total">
              {capLabel}
            </span>
          </PortalSettingsRow>
          <PortalSettingsRow label={`Included with ${doorTierName(tier)}`}>
            <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="residents-included">
              {included}
            </span>
          </PortalSettingsRow>
          <PortalSettingsRow label="Before the per-resident rate applies">
            <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="residents-remaining">
              {over > 0 ? `Over by ${over}` : remaining}
            </span>
          </PortalSettingsRow>
          <PortalSettingsRow label="Current bill">
            <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="residents-current-bill">
              {formatRateCardUsd(currentBillCents)}
              {billSuffix}
            </span>
          </PortalSettingsRow>
        </PortalSettingsGroup>
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
              label="Communication credits"
              fact={`Resets ${resetLabel(summary.communication.resetsAt)}`}
              primary={
                summary.communication.paused ? "Paused" : `${formatUsdFromCents(summary.communication.remainingCents)} left`
              }
              secondary={`${formatUsdFromCents(summary.communication.includedUsedCents)} of ${formatUsdFromCents(summary.communication.includedAllowanceCents)}`}
              percent={percentOf(summary.communication.includedUsedCents, summary.communication.includedAllowanceCents)}
              dataAttr="usage-communication"
            />
            <UsageBarRow
              label="Workspaces"
              primary={`${summary.workspaces.used} of ${summary.workspaces.max}`}
              percent={percentOf(summary.workspaces.used, summary.workspaces.max)}
              dataAttr="usage-workspaces"
            />
            <UsageBarRow
              label="Residents"
              primary={
                summary.residents.max === null
                  ? `${summary.residents.used}`
                  : `${summary.residents.used} of ${summary.residents.max}`
              }
              percent={percentOf(summary.residents.used, summary.residents.max)}
              dataAttr="usage-residents"
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
 * purchase (not a fixed pack) for ONE workspace's wallet, the included-credit
 * alert threshold as a percent, and the usage-rates disclosure. "Update usage"
 * always opens Stripe Checkout to confirm payment — a saved card never charges
 * silently (comms-billing compliance). Reads the same `summary` the Usage panel
 * above already fetched, and refetches it once the webhook-written wallet
 * catches up with a purchase.
 *
 * Only workspaces this manager OWNS are offered: a co-manager invitation is
 * not permission to spend the owner's money, and the route refuses it anyway.
 */
export function ManagerExtraUsagePanel({
  summary,
  load,
}: {
  summary: ManagerUsageSummary | null;
  load: () => Promise<ManagerUsageSummary | null>;
}) {
  const { isNative } = useIsNativeApp();
  const workspaceContext = useWorkspaces();
  const ownedWorkspaces = (workspaceContext?.workspaces ?? []).filter((w) => w.owned);
  const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
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

  // Return from Stripe embedded checkout: poll the wallet the purchase named
  // (≤20s) until the webhook-written credit shows up, rather than assuming it
  // landed. `comms_workspace` is the wallet that was bought for; without it the
  // purchase predates per-workspace credit and reads the default wallet.
  useEffect(() => {
    if (typeof window === "undefined" || returnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const purchaseId = params.get("comms_purchase");
    if (!purchaseId || !summary) return;
    returnHandled.current = true;
    const purchaseWorkspaceId = params.get("comms_workspace")?.trim() || null;
    const otherWorkspace =
      purchaseWorkspaceId && purchaseWorkspaceId !== summary.communication.workspaceId
        ? purchaseWorkspaceId
        : null;
    if (otherWorkspace) setWorkspaceOverride(otherWorkspace);
    const readWallet = async (): Promise<{ purchasedRemainingCents: number } | null> => {
      if (!otherWorkspace) {
        const next = await load();
        return next ? { purchasedRemainingCents: next.communication.purchasedRemainingCents } : null;
      }
      try {
        const res = await fetch(`${ENDPOINT}?workspaceId=${encodeURIComponent(otherWorkspace)}`, {
          credentials: "include",
          cache: "no-store",
        });
        const body = (await res.json()) as ManagerUsageSummary & { error?: string };
        if (!res.ok) return null;
        return { purchasedRemainingCents: body.communication.purchasedRemainingCents };
      } catch {
        return null;
      }
    };
    const id = window.setTimeout(() => {
      setPurchasePolling(true);
      void (async () => {
        // The pre-purchase figure for the wallet actually bought for. A read
        // that fails leaves the baseline honest rather than guessing zero.
        const baseline = otherWorkspace
          ? (await readWallet())?.purchasedRemainingCents ?? null
          : summary.communication.purchasedRemainingCents;
        if (baseline === null) return false;
        return pollUntilCreditPurchaseLands({
          previousPurchasedRemainingCents: baseline,
          load: readWallet,
        });
      })().then((landed) => {
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

  // The wallet the purchase lands in: the manager's pick, else whichever
  // workspace the loaded summary describes, else their only owned workspace.
  const creditWorkspaceId =
    workspaceOverride ??
    summary?.communication.workspaceId ??
    ownedWorkspaces.find((w) => w.isDefault)?.id ??
    ownedWorkspaces[0]?.id ??
    null;

  // The Usage section above reads the default workspace. When the manager is
  // buying for a different one, read that wallet so the figure beside the
  // picker is that workspace's own credit, never another's.
  const [pickedRemainingCents, setPickedRemainingCents] = useState<number | null>(null);
  useEffect(() => {
    setPickedRemainingCents(null);
    if (!creditWorkspaceId || !summary) return;
    if (creditWorkspaceId === summary.communication.workspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${ENDPOINT}?workspaceId=${encodeURIComponent(creditWorkspaceId)}`, {
          credentials: "include",
          cache: "no-store",
        });
        const body = (await res.json()) as ManagerUsageSummary & { error?: string };
        if (!res.ok || cancelled) return;
        setPickedRemainingCents(body.communication.remainingCents);
      } catch {
        // The picker still names the workspace; only its figure is withheld.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [creditWorkspaceId, summary]);

  const creditWorkspaceRemainingCents =
    creditWorkspaceId && summary && creditWorkspaceId === summary.communication.workspaceId
      ? summary.communication.remainingCents
      : pickedRemainingCents;

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
    if (!creditWorkspaceId) {
      setAmountError("Choose the workspace this credit is for.");
      return;
    }
    setBuyOpen(true);
    await checkout(amountCents, creditWorkspaceId);
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
                loading={loading && buyOpen}
                onClick={() => void buyCredit()}
                data-attr="extra-usage-update"
              >
                Update usage
              </Button>
            </div>
          ) : (
            <span className="text-sm text-muted">Managed on the web</span>
          )}
        </div>
        {ownedWorkspaces.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
            <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
              Credit applies to
              {creditWorkspaceRemainingCents === null ? null : (
                <span className="text-[12.5px] font-normal tabular-nums text-muted">
                  {formatUsdFromCents(creditWorkspaceRemainingCents)} left
                </span>
              )}
            </span>
            <FieldSingleSelect
              label="Credit applies to"
              hideLabel
              variant="cell"
              wrapperClassName="w-48"
              value={creditWorkspaceId ?? ""}
              onChange={(next) => setWorkspaceOverride(next)}
              disabled={!canBuy}
              options={ownedWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
              dataAttr="extra-usage-credit-workspace"
            />
          </div>
        ) : null}
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

      <Modal open={buyOpen} title="Confirm payment" onClose={closeBuy} assistantStrip={false} scrollableContent>
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
