"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  PortalSettingsDisclosureRow,
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal, ModalFooter } from "@/components/ui/modal";
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
const QUICK_AMOUNTS_CENTS = [1000, 2500, 5000, 10000];
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
  const { showToast } = useAppUi();
  const [amountChoice, setAmountChoice] = useState("2500");
  const [alertCents, setAlertCents] = useState<number | null>(null);
  const [alertLoaded, setAlertLoaded] = useState(false);
  const [customAlert, setCustomAlert] = useState(false);
  const [defaultCard, setDefaultCard] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/manager/comms-billing", { credentials: "include" }).then(res => res.ok ? res.json() : null).then(body => { if (active && body) { setAlertCents(body.creditAlertRemainingCents ?? null); setAlertLoaded(true); } }).catch(() => {});
    void fetch("/api/manager/payment-methods", { credentials: "include" }).then(res => res.ok ? res.json() : null).then(body => {
      const card = body?.cards?.find((row: { isDefault: boolean }) => row.isDefault);
      if (active) setDefaultCard(card ? `${card.brand} ····${card.last4}` : null);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const [amountInput, setAmountInput] = useState("25");
  const [amountError, setAmountError] = useState<string | null>(null);
  const appliesTo = summary?.fundsAllWorkspaces === false ? "one" : "all";
  const [pinnedWorkspaceId, setPinnedWorkspaceId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [purchasePolling, setPurchasePolling] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
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
    if (summary.purchases?.some(purchase => purchase.id === purchaseId && purchase.status === "paid")) {
      setPurchaseNotice("Credit added.");
      showToast("Credit added.");
      return;
    }
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
  }, [summary, load, showToast]);

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
    if (checkoutLoading) return;
    const purchasedBefore = summary?.purchasedRemainingCents ?? 0;
    const hadCheckout = Boolean(clientSecret);
    setBuyOpen(false); setClientSecret(null); setCheckoutError(null); operation.current = null;
    if (hadCheckout) {
      setPurchasePolling(true);
      void pollUntilCreditPurchaseLands({ previousPurchasedRemainingCents: purchasedBefore, load }).then(landed => {
        setPurchasePolling(false);
        if (landed) showToast("Credit added.");
        setPurchaseNotice(landed ? "Credit added." : "No completed purchase yet. Your balance is unchanged.");
      });
    }
  };

  const saveAlert = async (cents: number | null) => {
    if (!Number.isSafeInteger(cents) && cents !== null) return;
    setAlertBusy(true); setAlertNotice(null);
    try {
      const res = await fetch("/api/manager/comms-billing", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creditAlertRemainingCents: cents }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save the alert threshold.");
      setAlertCents(body.creditAlertRemainingCents ?? null); setAlertNotice("Saved");
    } catch (err) { setAlertNotice(err instanceof Error ? err.message : "Could not save the alert threshold."); }
    finally { setAlertBusy(false); }
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


  return (
    <PortalSettingsSection title="Messaging credit">
      {!summary ? <div className="h-40 animate-pulse rounded-xl border border-border bg-accent/30" aria-hidden /> : <>
        <PortalSettingsGroup>
          <div className="flex items-center justify-between gap-3 px-4 py-4"><div><span className="text-sm text-muted">Available</span><strong className="ml-3 text-xl tabular-nums" data-attr="messaging-credit-available">{paused ? "Paused" : formatUsdFromCents(summary.remainingCents)}</strong></div>
            {canBuy ? <Button onClick={() => { setBuyOpen(true); setAmountError(null); }} data-attr="messaging-credit-buy">Add credit</Button> : <span className="text-sm text-muted">{paused ? "Paused" : "Managed on the web"}</span>}
          </div>
          <div className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-accent/40" role="progressbar" aria-label="Included credit used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentOf(meterUsed, meterMax)}><div className="h-full bg-primary" style={{ width: `${percentOf(meterUsed, meterMax)}%` }} /></div>
          <PortalSettingsRow label="Included left"><span data-attr="messaging-credit-included">{formatUsdFromCents(summary.includedRemainingCents)}</span></PortalSettingsRow>
          <PortalSettingsRow label="Added credit"><span data-attr="messaging-credit-added">{formatUsdFromCents(summary.purchasedRemainingCents)}</span></PortalSettingsRow>
          <PortalSettingsRow label="Used this month"><span data-attr="messaging-credit-used">{formatUsdFromCents(summary.usedThisMonthCents)}</span></PortalSettingsRow>
          <PortalSettingsRow label="Resets"><span>{summary.periodEnd ? new Date(summary.periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</span></PortalSettingsRow>
          {purchasePolling || purchaseNotice ? <p role="status" className="px-4 py-2 text-sm">{purchasePolling ? "Confirming your purchase…" : purchaseNotice}</p> : null}
        </PortalSettingsGroup>
        <PortalSettingsGroup>
          <PortalSettingsRow label="Alert me when credit is at"><FieldSingleSelect label="Credit alert amount" hideLabel variant="cell" disabled={alertBusy || !alertLoaded} value={customAlert || (alertCents !== null && ![2000, 5000, 8000].includes(alertCents)) ? "other" : String(alertCents ?? "off")} onChange={value => { if (value === "other") setCustomAlert(true); else { setCustomAlert(false); void saveAlert(value === "off" ? null : Number(value)); } }} options={[{ value: "off", label: "Off" }, ...[2000, 5000, 8000].map(value => ({ value: String(value), label: formatUsdFromCents(value) })), { value: "other", label: "Other" }]} /></PortalSettingsRow>
          {customAlert ? <PortalSettingsRow label="Alert amount"><input type="number" min="0" max="10000" step="1" aria-label="Other credit alert amount" defaultValue={alertCents === null ? "" : alertCents / 100} onBlur={event => { const value = Number(event.target.value); if (event.target.value && Number.isFinite(value)) void saveAlert(Math.round(value * 100)); }} className="w-28 rounded-lg border border-border p-2 text-right" /></PortalSettingsRow> : null}
          {alertNotice ? <p role="status" className="px-4 py-2 text-sm">{alertNotice}</p> : null}
          <PortalSettingsDisclosureRow label="Workspace limits" dataAttr="messaging-credit-workspace-limits">
            <PortalSettingsRow label="Your credit funds"><FieldSingleSelect label="Your credit funds" hideLabel variant="cell" disabled={scopeBusy} value={summary.fundsAllWorkspaces ? "all" : summary.pinnedWorkspaceId ?? "all"} onChange={value => void saveScope(value === "all" ? { scope: "all" } : { scope: "one", workspaceId: value })} options={[{ value: "all", label: "All my workspaces" }, ...summary.workspaces.map(w => ({ value: w.workspaceId, label: w.name }))]} /></PortalSettingsRow>
            {summary.workspaces.map(w => <PortalSettingsRow key={w.workspaceId} label={w.name}><span className="text-sm">{formatUsdFromCents(w.usedThisMonthCents)} used</span>{w.enabled ? <FieldSingleSelect label={`${w.name} monthly limit`} hideLabel variant="cell" disabled={limitBusyWorkspaceId === w.workspaceId} value={String(w.monthlyLimitCents ?? "none")} onChange={value => void saveLimit(w.workspaceId, value === "none" ? null : Number(value))} options={MONTHLY_LIMIT_OPTIONS_CENTS.map(value => ({ value: String(value ?? "none"), label: limitLabel(value) }))} /> : <span className="text-sm text-muted">Not funded</span>}</PortalSettingsRow>)}
          </PortalSettingsDisclosureRow>
          <PortalSettingsDisclosureRow label="Usage rates" dataAttr="messaging-credit-rates">{ratesCents ? (Object.keys(ratesCents) as CommsBillingMeter[]).map(meter => <PortalSettingsRow key={meter} label={COMMS_BILLING_METER_LABELS[meter]}><span>{ratesCents[meter] === 0 ? "Included" : formatUsdFromCents(ratesCents[meter])}</span></PortalSettingsRow>) : null}</PortalSettingsDisclosureRow>
        </PortalSettingsGroup>
      </>}
      <Modal open={buyOpen} title="Add credit" onClose={closeBuy} assistantStrip={false} footer={clientSecret ? undefined : <ModalFooter><Button disabled={checkoutLoading || !amountCents || !isValidCommsCreditAmountCents(amountCents)} onClick={buyCredit}>Add {formatUsdFromCents(amountCents ?? 0)}</Button></ModalFooter>}>
        {clientSecret ? <EmbeddedCheckoutMount clientSecret={clientSecret} onError={setCheckoutError} /> : <>
          <FieldSingleSelect label="Amount" value={amountChoice} disabled={checkoutLoading} options={[...QUICK_AMOUNTS_CENTS.map(value => ({ value: String(value), label: formatUsdFromCents(value) })), { value: "other", label: "Other" }]} onChange={value => { setAmountChoice(value); if (value !== "other") setAmountInput(String(Number(value) / 100)); }} />
          {amountChoice === "other" ? <input aria-label="Other amount in dollars" inputMode="decimal" value={amountInput} onChange={event => setAmountInput(event.target.value)} className="mt-3 w-full rounded-xl border border-border p-3" data-attr="messaging-credit-amount" /> : null}
          <div className="mt-4"><PortalSettingsRow label="Pay with"><span>{defaultCard ?? "Add a card at checkout"}</span></PortalSettingsRow><PortalSettingsRow label="Purchase"><span>One-time · carries over</span></PortalSettingsRow><PortalSettingsRow label="New balance"><span>{formatUsdFromCents((summary?.remainingCents ?? 0) + (amountCents ?? 0))}</span></PortalSettingsRow></div>
          {amountError ? <p role="alert" className="text-sm text-danger">{amountError}</p> : null}
        </>}
        {checkoutError ? <p role="alert" className="mt-4 text-sm text-danger">{checkoutError}</p> : null}
      </Modal>
    </PortalSettingsSection>
  );
}

export const MESSAGING_CREDIT_AMOUNT_BOUNDS = { min: COMMS_CREDIT_MIN_CENTS, max: COMMS_CREDIT_MAX_CENTS };
