"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpFromLine, Calendar, CreditCard, Landmark, Plus } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import {
  formatDate,
  formatMoney,
  isPortalPayoutBalance,
  ScheduleCard,
  HistorySection,
  type PortalPayoutBalance,
  type PortalPayoutHistoryRow,
  type PortalPayoutsPortalKind,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { ProplaneBalanceCard } from "@/components/portal/proplane-balance-card";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { isPayoutDestinationSummary, type PayoutDestinationSummary } from "@/components/portal/payout-bank-sheet";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import Link from "next/link";
import { track } from "@/lib/analytics/track-client";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { vendorWithdrawableCents, vendorWithdrawDisabledReason } from "@/lib/vendor-banking/finances";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";

const PORTAL_API_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe",
  vendor: "/api/vendor",
};

const PORTAL_CONNECT_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe/connect",
  vendor: "/api/vendor/stripe-connect",
};

type BankAccountRow = PayoutDestinationSummary;

/**
 * One Payouts history row carries ONE title and one plain dated fact beside its
 * figure - never the movement said twice (the old row printed the server's
 * `serviceLabel` and the state derived from `status` as two unseparated spans,
 * reading "Moved from PropLane to StripeMoved to Stripe"). The state lives in
 * the title; the right cell stays date + amount (AGENTS.md § No subtext).
 */
function payoutHistoryTitle(row: PortalPayoutHistoryRow): string {
  if (row.kind === "source_movement") {
    return row.status === "paid" ? "Moved to Stripe" : row.status === "canceled" ? "Refunded" : "Captured";
  }
  const state = row.status.replaceAll("_", " ");
  return [
    `${row.method === "instant" ? "Instant" : "Standard"} payout`,
    row.destinationLast4 ? `····${row.destinationLast4}` : null,
    state.charAt(0).toUpperCase() + state.slice(1),
  ].filter(Boolean).join(" · ");
}

/** A per-row ⋯ that owns its own scope — mirrors `PayoutRowMenu` in `portal-payouts-panel.tsx`. */
function BankRowMenu({ rowId, label, children }: { rowId: string; label: string; children: ReactNode }) {
  return (
    <RecordActionContext.Provider value={{ scope: rowId, clear: () => {}, actions: children }}>
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

/**
 * Settings → Balance & payouts (manager `/portal/profile?tab=payments`, vendor
 * twin under `Vendor → Settings → Payouts`): balance with Withdraw, paying
 * vendors and bills, Bank accounts, Payouts.
 *
 * There is no Set up checklist and no separate "Verify identity" step: the
 * Bank accounts + is the ONE add-bank entry (`AddBankFlow`). When the connected
 * account cannot receive payouts yet it opens Stripe's embedded onboarding in
 * our popup (Stripe collects the identity it requires there); otherwise it
 * opens the in-app bank sheet. One connected Stripe account per payout owner
 * receives the workspace's money; its default bank gets every automatic payout
 * and Withdraw to picks among the others.
 */
export function PortalPayoutsSettingsPage({ portal }: { portal: PortalPayoutsPortalKind }) {
  const { showToast } = useAppUi();
  const workspace = useWorkspaces()?.active;
  const scopeKey = `${portal}:${workspace?.id ?? "owner"}`;
  const activeScopeRef = useRef(scopeKey);
  const [loadedScope, setLoadedScope] = useState(scopeKey);
  const [creditPurchases, setCreditPurchases] = useState<{ id: string; creditCents: number; createdAt: string; status: string }[]>([]);
  useEffect(() => {
    if (portal !== "manager") return;
    let active = true;
    void fetch("/api/manager/comms-credit-pool", { credentials: "include" }).then(res => res.ok ? res.json() : null).then(body => { if (active) setCreditPurchases(body?.purchases ?? []); }).catch(() => {});
    return () => { active = false; };
  }, [portal]);
  const [defaultMethod, setDefaultMethod] = useState("ach");
  const [balanceMethodEnabled, setBalanceMethodEnabled] = useState(false);
  const [methodLoaded, setMethodLoaded] = useState(false);
  const [methodBusy, setMethodBusy] = useState(false);
  useEffect(() => {
    if (portal !== "manager" || !workspace?.id) return;
    let active = true;
    setMethodLoaded(false);
    setBalanceMethodEnabled(false);
    setDefaultMethod("ach");
    void Promise.all([
      sharedGet(`/api/portal/manager-manual-payment-settings?workspaceId=${encodeURIComponent(workspace.id)}`),
      sharedGet("/api/portal/proplane-balance"),
    ])
      .then(([settingsResult, capabilityResult]) => {
        if (!active) return;
        if (!settingsResult.ok || !capabilityResult.ok) throw new Error("Payment preferences unavailable");
        const body = settingsResult.data as { workspacePaymentSettings?: Record<string, { defaultPaymentMethod?: string }> } | null;
        const capability = capabilityResult.data as { enabled?: boolean } | null;
        if (!body || !capability || typeof capability.enabled !== "boolean") throw new Error("Payment preferences unavailable");
        const enabled = capability.enabled;
        setBalanceMethodEnabled(enabled);
        const saved = body.workspacePaymentSettings?.[workspace.id]?.defaultPaymentMethod;
        setDefaultMethod(enabled && saved === "balance" ? "balance" : "ach");
        setMethodLoaded(true);
      })
      .catch(() => { if (active) showToast("Could not load payment preferences."); });
    return () => { active = false; };
  }, [portal, workspace?.id, showToast]);
  async function saveMethod(value: string) {
    if (!workspace?.owned || !methodLoaded || methodBusy || (value === "balance" && !balanceMethodEnabled)) return;
    setMethodBusy(true);
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, workspaceDefaultPaymentMethod: value }) });
      if (!res.ok) throw new Error();
      invalidateSharedGets("/api/portal/manager-manual-payment-settings");
      setDefaultMethod(value); showToast("Payment method saved.");
    } catch { showToast("Could not save payment method."); } finally { setMethodBusy(false); }
  }
  const apiBase = PORTAL_API_BASE[portal];
  const connectBase = PORTAL_CONNECT_BASE[portal];

  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [retryRow, setRetryRow] = useState<PortalPayoutHistoryRow | null>(null);
  const [bankSheetOpen, setBankSheetOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BankAccountRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  // Withdraw to: a per-visit pick among the banks. It never changes the default
  // (that is Make default); null = follow the default.
  const [withdrawToId, setWithdrawToId] = useState<string | null>(null);

  const [bankRows, setBankRows] = useState<BankAccountRow[] | null>(null);
  const [bankLoadError, setBankLoadError] = useState<string | null>(null);
  const [bankRoute, setBankRoute] = useState<"live" | "loading">("loading");

  const loadBalance = useCallback(async (force = false) => {
    if (activeScopeRef.current !== scopeKey) return;
    setLoading(true);
    setLoadError(null);
    const result = await sharedGet(`${apiBase}/payouts/balance`, { ttlMs: force ? 0 : undefined });
    if (activeScopeRef.current !== scopeKey) return;
    if (!result.ok || !isPortalPayoutBalance(result.data)) {
      setLoadError("Could not load payouts.");
    } else {
      setBalance(result.data);
    }
    setLoading(false);
  }, [apiBase, scopeKey]);

  // Destination authority comes from the live list. An inaccessible or malformed
  // list cannot be replaced with the balance's display-only bank summary.
  const loadBankAccounts = useCallback(async (force = false) => {
    if (activeScopeRef.current !== scopeKey) return;
    setBankLoadError(null);
    setBankRoute("loading");
    const result = await sharedGet(`${connectBase}/bank-accounts`, { ttlMs: force ? 0 : undefined });
    if (activeScopeRef.current !== scopeKey) return;
    const body = result.ok ? result.data as { destinations?: unknown } | null : null;
    if (!body || !Array.isArray(body.destinations) || !body.destinations.every(isPayoutDestinationSummary)) {
      setBankLoadError("Could not verify payout bank accounts.");
      return;
    }
    setBankRows(body.destinations as BankAccountRow[]);
    setBankRoute("live");
  }, [connectBase, scopeKey]);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    setLoadedScope(scopeKey);
    setBalance(null);
    setBankRows(null);
    setLoading(true);
    setBankRoute("loading");
    void loadBalance(true);
    void loadBankAccounts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, connectBase, scopeKey]);

  const closeWithdraw = useCallback(() => {
    setWithdrawOpen(false);
    setRetryRow(null);
  }, []);

  const closeBankSheet = useCallback(() => {
    setBankSheetOpen(false);
    void loadBalance(true);
    void loadBankAccounts(true);
  }, [loadBalance, loadBankAccounts]);

  async function makeDefault(id: string) {
    try {
      const res = await fetch(`${connectBase}/bank-accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: true }),
      });
      if (!res.ok) {
        showToast("Could not change the default account.");
        return;
      }
      setWithdrawToId(null);
      invalidateSharedGets(`${connectBase}/bank-accounts`);
      invalidateSharedGets(`${apiBase}/payouts/balance`);
      await Promise.all([loadBankAccounts(true), loadBalance(true)]);
    } catch {
      showToast("Could not change the default account.");
    }
  }

  async function removeBank(id: string) {
    setRemoveBusy(true);
    try {
      const res = await fetch(`${connectBase}/bank-accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(body.error ?? "Could not remove that account.");
        return;
      }
      setRemoveTarget(null);
      setWithdrawToId(null);
      invalidateSharedGets(`${connectBase}/bank-accounts`);
      invalidateSharedGets(`${apiBase}/payouts/balance`);
      await Promise.all([loadBankAccounts(true), loadBalance(true)]);
    } catch {
      showToast("Could not remove that account.");
    } finally {
      setRemoveBusy(false);
    }
  }

  const effectiveBankRows: BankAccountRow[] = useMemo(
    () => bankRoute === "live" && bankRows ? bankRows : [],
    [bankRoute, bankRows],
  );

  // Withdraw to: the default bank unless the owner picked another; the Withdraw
  // sheet opens on it (it preselects the first account it is given).
  const withdrawToDefault = effectiveBankRows.find((row) => row.default && row.payable) ??
    effectiveBankRows.find((row) => row.payable) ?? null;
  const withdrawToSelectedId =
    withdrawToId && effectiveBankRows.some((row) => row.id === withdrawToId && row.payable)
      ? withdrawToId : (withdrawToDefault?.id ?? "");

  const withdrawAccounts: PayoutWithdrawAccount[] = useMemo(() => {
    const accounts: PayoutWithdrawAccount[] =
      bankRoute === "live" && bankRows
        ? bankRows.filter((row) => row.payable).map((row) => ({
            id: row.id, label: row.label, last4: row.last4,
            kind: row.kind, instantEligible: row.instantEligible,
          }))
        : [];
    return [...accounts].sort(
      (a, b) => Number(b.id === withdrawToSelectedId) - Number(a.id === withdrawToSelectedId),
    );
  }, [bankRoute, bankRows, withdrawToSelectedId]);

  if (loadedScope !== scopeKey) {
    return <PortalRecordListSurface loading dataAttr="payouts-settings-loading" />;
  }
  if (loadError || bankLoadError) {
    return (
      <PortalRecordListSurface
        loadError={loadError ?? bankLoadError ?? "Could not load payouts."}
        onRetry={() => {
          void loadBalance(true);
          void loadBankAccounts(true);
        }}
        dataAttr="payouts-settings-error"
      />
    );
  }
  if (loading || bankRoute === "loading") {
    return <PortalRecordListSurface loading dataAttr="payouts-settings-loading" />;
  }
  if (!balance) {
    return <PortalRecordListSurface loadError="Could not load payouts." onRetry={() => {
      void loadBalance(true);
      void loadBankAccounts(true);
    }} dataAttr="payouts-settings-error" />;
  }

  const ready = balance.setup.ready;
  const hasBank = effectiveBankRows.some((row) => row.payable);
  const withdrawableCents = withdrawableCentsFromSnapshot(balance);
  // Vendor Withdraw reads the same derivations as Finances > Balance & payouts.
  const vendorWithdrawable = vendorWithdrawableCents(balance);
  const vendorWithdrawBlocked = portal === "vendor" ? vendorWithdrawDisabledReason(balance, hasBank) : null;
  const providerDeficitCents = Math.max(0, -(balance.withdrawableCents ?? 0));
  const removeBlocked = removeTarget != null && removeTarget.default && effectiveBankRows.length > 1;

  return (
    <div className="space-y-4" data-attr="payouts-settings-page">
      <AddBankFlow open={bankSheetOpen} onClose={closeBankSheet} portal={portal} onAdded={() => { void loadBalance(true); void loadBankAccounts(true); }} />
      <ConfirmDeleteModal
        open={removeTarget != null}
        title="Remove bank account"
        confirmLabel="Remove"
        busyLabel="Removing…"
        description={
          removeTarget
            ? removeBlocked
              ? "Make another account the default before removing this one."
              : `${removeTarget.label} ····${removeTarget.last4}`
            : ""
        }
        note={removeBlocked ? null : "Payouts will stop going to this account."}
        busy={removeBusy}
        confirmDisabled={removeBlocked}
        onClose={() => { if (!removeBusy) setRemoveTarget(null); }}
        onConfirm={() => { if (removeTarget && !removeBlocked) void removeBank(removeTarget.id); }}
        dataAttr="payouts-settings-bank-remove-confirm"
      />

      {portal === "vendor" ? (
        <PortalSettingsSection
          title="Balance & payouts"
          action={
            <PortalIconAction
              icon={ArrowUpFromLine}
              label={vendorWithdrawBlocked ? `Withdraw — ${vendorWithdrawBlocked}` : "Withdraw"}
              data-attr="payouts-settings-withdraw"
              disabled={vendorWithdrawBlocked !== null}
              onClick={() => { track("payout_withdraw_started", { portal, source: "settings_payouts" }); setWithdrawOpen(true); }}
            />
          }
        >
          <PortalSettingsGroup>
            <PortalSettingsRow label="Available to withdraw"><span data-attr="payouts-settings-available">{formatMoney(vendorWithdrawable, balance.currency)}</span></PortalSettingsRow>
            <PortalSettingsRow label="Balance, payouts and statements">
              <Link href="/vendor/financials/payouts" className="text-sm font-medium text-primary hover:underline" data-attr="payouts-settings-finances-link">
                Open Finances
              </Link>
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ) : null}
      {portal === "manager" ? <PortalSettingsSection title="PropLane balance" action={<PortalIconAction icon={ArrowUpFromLine} label="Withdraw" data-attr="payouts-settings-withdraw" disabled={!ready || !hasBank || balance.payoutReconciliationPending || withdrawableCents <= 0} onClick={() => { track("payout_withdraw_started", { portal }); setWithdrawOpen(true); }} />}>
        <PortalSettingsGroup>
          <PortalSettingsRow label="Available to withdraw"><span data-attr="payouts-settings-available">{formatMoney(withdrawableCents, balance.currency)}</span></PortalSettingsRow>
          {(balance.heldCents ?? 0) > 0 ? <PortalSettingsRow label="Held pending bank"><span data-attr="payouts-settings-held">{formatMoney(balance.heldCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {(balance.releasePendingCents ?? 0) > 0 ? <PortalSettingsRow label="Release pending"><span data-attr="payouts-settings-release-pending">{formatMoney(balance.releasePendingCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.pendingCents > 0 ? <PortalSettingsRow label="Pending payments"><span data-attr="payouts-settings-payment-pending">{formatMoney(balance.pendingCents, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.onTheWayCents > 0 ? <PortalSettingsRow label="On the way"><span data-attr="payouts-settings-payout-on-way">{formatMoney(balance.onTheWayCents, balance.currency)}</span></PortalSettingsRow> : null}
          {providerDeficitCents > 0 ? <PortalSettingsRow label="Provider deficit"><span data-attr="payouts-settings-provider-deficit">{formatMoney(providerDeficitCents, balance.currency)}</span></PortalSettingsRow> : null}
          {(balance.recoveryOutstandingCents ?? 0) > 0 ? <PortalSettingsRow label="Recovery owed"><span data-attr="payouts-settings-recovery-owed">{formatMoney(balance.recoveryOutstandingCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {(balance.recoveryReservedCents ?? 0) > 0 ? <PortalSettingsRow label="Recovery reserved"><span data-attr="payouts-settings-recovery-reserved">{formatMoney(balance.recoveryReservedCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.payoutReconciliationPending ? <PortalSettingsRow label="Payout status"><span>Checking a prior withdrawal</span></PortalSettingsRow> : null}

          {balance.availableNote ? <PortalSettingsRow label="Funds status"><span data-attr="payouts-settings-available-note">{balance.availableNote}</span></PortalSettingsRow> : null}
        </PortalSettingsGroup>
      </PortalSettingsSection> : null}

      {portal === "manager" ? <PortalSettingsSection title="Paying vendors and bills"><PortalSettingsGroup>
        <PortalSettingsRow label="Default payment method"><FieldSingleSelect label="Default payment method" hideLabel variant="cell" value={defaultMethod} disabled={!methodLoaded || methodBusy || !workspace?.owned} onChange={value => void saveMethod(value)} options={[...(balanceMethodEnabled ? [{ value: "balance", label: "PropLane balance" }] : []), { value: "ach", label: "Bank account" }]} /></PortalSettingsRow>
      </PortalSettingsGroup></PortalSettingsSection> : null}
      {portal === "vendor" ? <ProplaneBalanceCard portal={portal} /> : null}

      {/* Bank accounts */}
      <PortalSettingsSection
        title="Bank accounts"
        action={<PortalIconAction icon={Plus} label="Add a bank account" onClick={() => setBankSheetOpen(true)} data-attr="payouts-settings-bank-add" />}
      >
        <PortalSettingsGroup>
          {effectiveBankRows.length === 0 ? (
            <div className="px-4 py-3.5 text-sm text-muted">No bank account yet</div>
          ) : (
            effectiveBankRows.map((row) => (
              <div key={row.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0" data-attr="payouts-settings-bank-row">
                <div aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/[0.08] text-primary">
                  {row.kind === "card" ? <CreditCard className="size-5" strokeWidth={1.6} /> : <Landmark className="size-5" strokeWidth={1.6} />}
                </div>
                <p className="min-w-0 flex-1 truncate text-[15px] font-normal text-foreground">
                  {row.label} ····{row.last4}
                </p>
                {row.default || row.status !== "verified" ? (
                  <span className="shrink-0 text-sm text-muted">
                    {[row.default ? "Default" : null,
                      row.status === "new" ? "Added" : row.status === "validated" ? "Validated"
                        : row.status === "errored" ? "Needs attention" : row.status === "unknown" ? "Unavailable" : null]
                      .filter(Boolean).join(" · ")}
                  </span>
                ) : null}
                {bankRoute === "live" ? (
                  <BankRowMenu rowId={row.id} label={`${row.label} ····${row.last4}`}>
                    {!row.default && row.payable ? (
                      <Button type="button" variant="outline" onClick={() => makeDefault(row.id)} data-attr="payouts-settings-bank-default">
                        Make default
                      </Button>
                    ) : null}
                    <Button type="button" variant="danger" onClick={() => setRemoveTarget(row)} data-attr="payouts-settings-bank-remove">
                      Remove
                    </Button>
                  </BankRowMenu>
                ) : null}
              </div>
            ))
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {/* Schedule */}
      {portal === "vendor" ? <ScheduleCard
        schedule={balance.schedule}
        availableCents={withdrawableCents}
        currency={balance.currency}
        portal={portal}
        onChange={async (interval) => {
          try {
            const res = await fetch(`${apiBase}/payouts/schedule`, {
              method: "PUT",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ interval }),
            });
            if (!res.ok) throw new Error("Could not update the schedule");
            invalidateSharedGets(`${apiBase}/payouts/balance`);
            await loadBalance(true);
          } catch {
            showToast("Could not update the schedule.");
            void loadBalance(true);
          }
        }}
      /> : null}

      {/* History — the vendor's payout history lives in Finances → Balance & payouts. */}
      {portal === "manager" ? <PortalSettingsSection title="Payouts"><PortalSettingsGroup>
          {hasBank ? <PortalSettingsRow label="Withdraw to"><FieldSingleSelect label="Withdraw to" hideLabel variant="cell" value={withdrawToSelectedId} disabled={effectiveBankRows.length < 2} onChange={id => setWithdrawToId(id)} options={effectiveBankRows.map(row => ({ value: row.id, label: `${row.label} ····${row.last4}`, disabled: !row.payable }))} /></PortalSettingsRow> : null}
        {balance.history.length ? balance.history.map(row => <PortalSettingsRow key={row.id} label={payoutHistoryTitle(row)}>
          <div className="flex items-center justify-end gap-3">
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted">
              <Calendar aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              {formatDate(row.createdAt)}
            </span>
            <span className="text-sm">{formatMoney(row.amountCents, balance.currency)}</span>
            {row.kind !== "source_movement" && row.status === "failed" && !balance.payoutReconciliationPending ? <BankRowMenu rowId={row.id} label="Payout">
              <Button variant="outline" onClick={() => { setRetryRow(row); setWithdrawOpen(true); }}>Retry</Button>
            </BankRowMenu> : null}
          </div>
        </PortalSettingsRow>) : <PortalSettingsRow label="No payouts yet" />}
      </PortalSettingsGroup></PortalSettingsSection> : null}

      {portal === "manager" && creditPurchases.length ? <PortalSettingsSection title="Payments activity"><PortalSettingsGroup>
        {creditPurchases.map(purchase => <PortalSettingsRow key={purchase.id} label="Messaging credit"><span className="text-sm text-muted">{formatDate(purchase.createdAt)} · Card · {purchase.status === "paid" ? "Paid" : purchase.status.replaceAll("_", " ")}</span><span >{formatMoney(purchase.creditCents, "usd")}</span></PortalSettingsRow>)}
      </PortalSettingsGroup></PortalSettingsSection> : null}

      <PayoutWithdrawSheet
        open={withdrawOpen}
        onClose={closeWithdraw}
        apiBase={apiBase}
        currency={balance.currency}
        availableCents={portal === "vendor" ? vendorWithdrawable : withdrawableCents}
        instantAvailableCents={balance.instantAvailableCents}
        accounts={withdrawAccounts}
        initialAmountCents={retryRow?.amountCents}
        initialMethod={retryRow?.method ?? undefined}
        onSuccess={(result) => {
          closeWithdraw();
          track("payout_withdraw_completed", { portal, method: result.method, amount_cents: result.amountCents });
          void loadBalance(true);
        }}
      />
    </div>
  );
}
