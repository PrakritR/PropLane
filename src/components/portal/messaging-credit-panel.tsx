"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  PortalSettingsDisclosureRow,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";
import { EmbeddedCheckoutMount } from "@/components/stripe/embedded-checkout";
import { formatUsdFromCents, COMMS_BILLING_METER_LABELS, type CommsBillingMeter } from "@/lib/comms-billing/rates";
import {
  COMMS_CREDIT_MAX_CENTS,
  COMMS_CREDIT_MIN_CENTS,
  isValidCommsCreditAmountCents,
} from "@/lib/comms-billing/credit-packs";
import { pollUntilCreditPurchaseLands } from "@/lib/comms-billing/use-credit-checkout";
import type { CommsCreditPoolSummary } from "@/app/api/manager/comms-credit-pool/route";
import type { ManagerUsageSummary } from "@/app/api/manager/usage-summary/route";

const ENDPOINT = "/api/manager/comms-credit-pool";
const QUICK_AMOUNTS_CENTS = [1000, 2500, 5000];
const MONTHLY_LIMIT_OPTIONS_CENTS = [null, 1000, 2500, 5000, 10000] as const;

function limitLabel(cents: number | null): string {
  return cents === null ? "No limit" : formatUsdFromCents(cents);
}

function percentOf(used: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (used / max) * 100));
}

export function useCommsCreditPoolSummary() {
  const [summary, setSummary] = useState<CommsCreditPoolSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<CommsCreditPoolSummary | null> => {
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as CommsCreditPoolSummary & { error?: string };
      if (!res.ok) throw new Error(body.error || "We couldn't load your messaging credit.");
      if (mounted.current) {
        setSummary(body);
        setError(null);
      }
      return body;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "We couldn't load your messaging credit.");
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

/**
 * Settings → Billing & plan → Messaging credit (S27, behind
 * `COMMS_CREDIT_POOL_ENABLED`). Replaces the legacy "Extra usage" panel when
 * the flag is on: one account-level pool the signed-in manager (or a
 * co-manager) funds, which overflows across every workspace they choose to
 * fund, with an optional per-workspace monthly cap.
 */
export function MessagingCreditPanel({
  summary,
  ratesCents,
  load,
}: {
  summary: CommsCreditPoolSummary | null;
  ratesCents: ManagerUsageSummary["ratesCents"] | undefined;
  load: () => Promise<CommsCreditPoolSummary | null>;
}) {
  const { isNative } = useIsNativeApp();
  const [amountInput, setAmountInput] = useState("25");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [appliesTo, setAppliesTo] = useState<"all" | "one">("all");
  const [pinnedWorkspaceId, setPinnedWorkspaceId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [purchasePolling, setPurchasePolling] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
  const [alertOverride, setAlertOverride] = useState<number | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertNotice, setAlertNotice] = useState<string | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [limitBusyWorkspaceId, setLimitBusyWorkspaceId] = useState<string | null>(null);
  const returnHandled = useRef(false);
  const operation = useRef<{ id: string; amount: number; appliesTo: string } | null>(null);

  useEffect(() => {
    if (!summary) return;
    setPinnedWorkspaceId((prev) => prev ?? summary.pinnedWorkspaceId ?? summary.workspaces[0]?.workspaceId ?? null);
  }, [summary]);

  useEffect(() => {
    if (typeof window === "undefined" || returnHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const purchaseId = params.get("comms_pool_purchase");
    if (!purchaseId || !summary) return;
    returnHandled.current = true;
    const baseline = summary.purchasedRemainingCents;
    const id = window.setTimeout(() => {
      setPurchasePolling(true);
      void pollUntilCreditPurchaseLands({
        previousPurchasedRemainingCents: baseline,
        load: async () => {
          const next = await load();
          return next ? { purchasedRemainingCents: next.purchasedRemainingCents } : null;
        },
      }).then((landed) => {
        setPurchasePolling(false);
        setPurchaseNotice(landed ? "Credit added." : "Payment received. Your balance is still updating — refresh in a moment.");
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
    setCheckoutError(null);
    if (amountCents === null || !isValidCommsCreditAmountCents(amountCents)) {
      setAmountError("Enter a whole-dollar amount from $5 to $500.");
      return;
    }
    if (appliesTo === "one" && !pinnedWorkspaceId) {
      setAmountError("Choose a workspace.");
      return;
    }
    const appliesToValue = appliesTo === "all" ? "all" : String(pinnedWorkspaceId);
    if (
      !operation.current ||
      operation.current.amount !== amountCents ||
      operation.current.appliesTo !== appliesToValue
    ) {
      operation.current = { id: crypto.randomUUID(), amount: amountCents, appliesTo: appliesToValue };
    }
    setBuyOpen(true);
    setCheckoutLoading(true);
    try {
      const res = await fetch(`${ENDPOINT}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseId: operation.current.id, creditCents: amountCents, appliesTo: appliesToValue }),
      });
      const body = (await res.json()) as { clientSecret?: string; error?: string };
      if (!res.ok || !body.clientSecret) throw new Error(body.error || "Checkout could not be opened.");
      setClientSecret(body.clientSecret);
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Checkout could not be opened.");
    } finally {
      setCheckoutLoading(false);
    }
  };

  const closeBuy = () => {
    setBuyOpen(false);
    setClientSecret(null);
    setCheckoutError(null);
    operation.current = null;
    void load();
  };

  const serverAlertPercent = (() => {
    if (!summary) return 80;
    return 80;
  })();
  const alertPercent = alertOverride ?? serverAlertPercent;

  const saveAlert = async () => {
    if (!summary) return;
    setAlertBusy(true);
    setAlertNotice(null);
    try {
      const cents = Math.round((summary.allowanceCents * alertPercent) / 100);
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
      setAlertOverride(null);
    } catch {
      setAlertNotice("Could not save the alert threshold. Try again.");
    } finally {
      setAlertBusy(false);
    }
  };

  const saveScope = async (next: { scope: "all" } | { scope: "one"; workspaceId: string }) => {
    setScopeBusy(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (res.ok) await load();
    } finally {
      setScopeBusy(false);
    }
  };

  const saveLimit = async (workspaceId: string, monthlyLimitCents: number | null) => {
    setLimitBusyWorkspaceId(workspaceId);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, monthlyLimitCents }),
      });
      if (res.ok) await load();
    } finally {
      setLimitBusyWorkspaceId(null);
    }
  };

  const paused = Boolean(summary?.paused);
  const canBuy = isNative === false && !paused;
  const meterMax = summary ? Math.max(1, summary.allowanceCents) : 1;
  const meterUsed = summary ? Math.max(0, summary.allowanceCents - summary.includedRemainingCents) : 0;
  const alertMarkerPercent = summary ? Math.min(100, Math.max(0, (alertPercent))) : 0;

  return (
    <PortalSettingsSection title="Messaging credit">
      {!summary ? (
        <div className="h-40 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
      ) : (
        <>
          <PortalSettingsGroup>
            <div className="border-b border-border px-4 py-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-foreground">Available</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground" data-attr="messaging-credit-available">
                  {summary.paused ? "Paused" : formatUsdFromCents(summary.remainingCents)}
                </span>
              </div>
              <div className="relative mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-accent/40" aria-hidden>
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percentOf(meterUsed, meterMax)}%` }} />
                <div
                  className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-[var(--status-overdue-fg)]"
                  style={{ left: `${alertMarkerPercent}%` }}
                  title={`Alert at ${alertPercent}%`}
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted">
                <div>
                  <div className="font-semibold tabular-nums text-foreground" data-attr="messaging-credit-included">
                    {formatUsdFromCents(summary.includedRemainingCents)}
                  </div>
                  Included left
                </div>
                <div>
                  <div className="font-semibold tabular-nums text-foreground" data-attr="messaging-credit-added">
                    {formatUsdFromCents(summary.purchasedRemainingCents)}
                  </div>
                  Added credit
                </div>
                <div>
                  <div className="font-semibold tabular-nums text-foreground" data-attr="messaging-credit-used">
                    {formatUsdFromCents(summary.usedThisMonthCents)}
                  </div>
                  Used this month
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
              <span className="text-sm font-medium text-foreground">Add credit</span>
              {paused ? (
                <span className="text-sm text-muted">Paused</span>
              ) : canBuy ? (
                <div className="flex flex-wrap items-center gap-2">
                  {QUICK_AMOUNTS_CENTS.map((cents) => (
                    <Button
                      key={cents}
                      type="button"
                      variant={amountCents === cents ? "primary" : "outline"}
                      className="rounded-full text-[13px]"
                      onClick={() => {
                        setAmountInput(String(cents / 100));
                        setAmountError(null);
                      }}
                    >
                      {formatUsdFromCents(cents)}
                    </Button>
                  ))}
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
                      aria-label="Other amount in dollars"
                      data-attr="messaging-credit-amount"
                    />
                  </div>
                  <Button variant="outline" className="rounded-full text-[13px]" loading={checkoutLoading && buyOpen} onClick={() => void buyCredit()} data-attr="messaging-credit-buy">
                    Add credit
                  </Button>
                </div>
              ) : (
                <span className="text-sm text-muted">Managed on the web</span>
              )}
            </div>
            {canBuy && !paused ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
                <span className="text-sm font-medium text-foreground">Applies to</span>
                <FieldSingleSelect
                  label="Applies to"
                  hideLabel
                  variant="cell"
                  wrapperClassName="w-56"
                  value={appliesTo === "all" ? "all" : pinnedWorkspaceId ?? "all"}
                  onChange={(next) => {
                    if (next === "all") setAppliesTo("all");
                    else {
                      setAppliesTo("one");
                      setPinnedWorkspaceId(next);
                    }
                  }}
                  options={[
                    { value: "all", label: `All my workspaces (${summary.workspaces.length})` },
                    ...summary.workspaces.map((w) => ({ value: w.workspaceId, label: `${w.name} only` })),
                  ]}
                  dataAttr="messaging-credit-applies-to"
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
              <p role="status" className="border-b border-border px-4 py-2 text-xs text-muted" data-attr="messaging-credit-purchase-notice">
                {purchaseNotice}
              </p>
            ) : null}
          </PortalSettingsGroup>

          <PortalSettingsGroup>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
              <span className="text-sm font-medium text-foreground">Your credit funds</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={summary.fundsAllWorkspaces ? "primary" : "outline"}
                  className="rounded-full text-[13px]"
                  disabled={scopeBusy}
                  onClick={() => void saveScope({ scope: "all" })}
                  data-attr="messaging-credit-funds-all"
                >
                  All my workspaces ({summary.workspaces.length})
                </Button>
                {summary.workspaces.length === 1 ? (
                  <span className="text-xs text-muted">only workspace</span>
                ) : (
                  <FieldSingleSelect
                    label="Fund only"
                    hideLabel
                    variant="cell"
                    wrapperClassName="w-48"
                    value={!summary.fundsAllWorkspaces ? summary.pinnedWorkspaceId ?? "" : ""}
                    onChange={(next) => next && void saveScope({ scope: "one", workspaceId: next })}
                    disabled={scopeBusy}
                    options={summary.workspaces.map((w) => ({ value: w.workspaceId, label: `${w.name} only` }))}
                    dataAttr="messaging-credit-funds-one"
                  />
                )}
              </div>
            </div>
            {summary.workspaces.map((w) => (
              <div key={w.workspaceId} className="border-b border-border px-4 py-3.5 last:border-0" data-attr="messaging-credit-workspace-row">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
                    {w.name}
                    <span className="text-[12.5px] font-normal text-muted">{w.owned ? "Owner" : `Co-manager · ${w.ownerName ?? "shared"}`}</span>
                    {!w.enabled ? <span className="text-[12.5px] font-normal text-muted">not funded</span> : null}
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">{formatUsdFromCents(w.usedThisMonthCents)} used</span>
                </div>
                {w.enabled ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-xs text-muted">Monthly limit</span>
                    <FieldSingleSelect
                      label="Monthly limit"
                      hideLabel
                      variant="cell"
                      wrapperClassName="w-40"
                      value={String(w.monthlyLimitCents ?? "none")}
                      disabled={limitBusyWorkspaceId === w.workspaceId}
                      onChange={(next) => void saveLimit(w.workspaceId, next === "none" ? null : Number(next))}
                      options={MONTHLY_LIMIT_OPTIONS_CENTS.map((cents) => ({
                        value: cents === null ? "none" : String(cents),
                        label: limitLabel(cents),
                      }))}
                      dataAttr="messaging-credit-monthly-limit"
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </PortalSettingsGroup>

          <PortalSettingsGroup>
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
                <span className="w-10 text-center text-sm font-semibold tabular-nums" data-attr="messaging-credit-alert-percent">
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
            <PortalSettingsDisclosureRow label="Usage rates" dataAttr="messaging-credit-rates">
              <div className="space-y-0">
                {ratesCents
                  ? (Object.keys(ratesCents) as CommsBillingMeter[]).map((meter) => (
                      <div key={meter} className="flex flex-wrap justify-between gap-3 border-t border-border py-2.5 text-sm first:border-t-0">
                        <span>{COMMS_BILLING_METER_LABELS[meter]}</span>
                        <span className="tabular-nums">{ratesCents[meter] === 0 ? "Included" : formatUsdFromCents(ratesCents[meter])}</span>
                      </div>
                    ))
                  : null}
              </div>
            </PortalSettingsDisclosureRow>
            <PortalSettingsRow label="Plan">
              <span className="text-sm text-muted">
                {summary.tier} · {summary.sharedAcrossWorkspaces ? "shared across workspaces" : "your default workspace only"}
                {summary.rollsOver ? " · unused rolls over" : ""}
              </span>
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </>
      )}

      <Modal open={buyOpen} title="Confirm payment" onClose={closeBuy} assistantStrip={false} scrollableContent>
        {clientSecret ? (
          <EmbeddedCheckoutMount clientSecret={clientSecret} onError={() => closeBuy()} />
        ) : (
          <p className="py-8 text-center text-sm text-muted">{checkoutLoading ? "Preparing secure checkout…" : "Starting checkout…"}</p>
        )}
        {checkoutError ? (
          <p role="alert" className="mt-4 text-sm text-danger">
            {checkoutError}
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

export const MESSAGING_CREDIT_AMOUNT_BOUNDS = { min: COMMS_CREDIT_MIN_CENTS, max: COMMS_CREDIT_MAX_CENTS };
