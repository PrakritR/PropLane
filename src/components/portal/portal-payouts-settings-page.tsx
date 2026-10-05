"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpFromLine, CreditCard, Landmark, Plus } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import {
  bankToWithdrawAccounts,
  formatDate,
  formatMoney,
  ScheduleCard,
  HistorySection,
  type PortalPayoutBalance,
  type PortalPayoutHistoryRow,
  type PortalPayoutsPortalKind,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { ProplaneBalanceCard } from "@/components/portal/proplane-balance-card";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { VendorPayoutsSettingsExtra } from "@/components/portal/vendor-payouts-settings-extra";
import { track } from "@/lib/analytics/track-client";
import { withdrawableCentsFromSnapshot } from "@/lib/stripe-platform-hold";
import { useAppUi } from "@/components/providers/app-ui-provider";

const PORTAL_API_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe",
  vendor: "/api/vendor",
};

const PORTAL_CONNECT_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe/connect",
  vendor: "/api/vendor/stripe-connect",
};

type BankAccountRow = {
  id: string;
  kind: "bank" | "card";
  label: string;
  last4: string;
  status: "new" | "validated" | "verified" | "errored" | "unknown";
  payable: boolean;
  instantEligible: boolean;
  default: boolean;
};

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
    void Promise.all([
      fetch(`/api/portal/manager-manual-payment-settings?workspaceId=${encodeURIComponent(workspace.id)}`, { credentials: "include" }).then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error); return body; }),
      fetch("/api/portal/proplane-balance", { credentials: "include" }).then(async res => { if (!res.ok) throw new Error("Balance unavailable"); return res.json() as Promise<{ enabled?: boolean }>; }),
    ])
      .then(([body, capability]) => { if (active) { const enabled = capability.enabled === true; setBalanceMethodEnabled(enabled); const saved = body.workspacePaymentSettings?.[workspace.id]?.defaultPaymentMethod; setDefaultMethod(enabled && saved === "balance" ? "balance" : "ach"); setMethodLoaded(true); } })
      .catch(() => { if (active) showToast("Could not load payment preferences."); });
    return () => { active = false; };
  }, [portal, workspace?.id, showToast]);
  async function saveMethod(value: string) {
    if (!workspace?.owned || !methodLoaded || methodBusy || (value === "balance" && !balanceMethodEnabled)) return;
    setMethodBusy(true);
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, workspaceDefaultPaymentMethod: value }) });
      if (!res.ok) throw new Error();
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
  const [bankRoute, setBankRoute] = useState<"live" | "fallback" | "loading">("loading");

  const loadBalance = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${apiBase}/payouts/balance`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as Partial<PortalPayoutBalance> & { error?: string };
      if (!res.ok) {
        setLoadError(body.error ?? "Could not load payouts.");
        return;
      }
      setBalance(body as PortalPayoutBalance);
    } catch {
      setLoadError("Could not load payouts.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  // Bank accounts: prefer the dedicated list route
  // (`GET …/bank-accounts` → `{ destinations: PayoutDestination[] }`,
  // default-for-currency sorted first). Its absence (any non-2xx, including
  // a 404) is expected, not an error — fall back to the single external
  // account the balance endpoint already carries, read-only (no ⋯ menu —
  // there is nothing this page can act on through the old status endpoint
  // alone). `PayoutDestination.status` includes "errored", which a bank row
  // never was — fold it into "verifying" rather than claiming "verified".
  const loadBankAccounts = useCallback(async () => {
    setBankLoadError(null);
    setBankRoute("loading");
    try {
      const res = await fetch(`${connectBase}/bank-accounts`, { credentials: "include" });
      if (!res.ok) {
        setBankLoadError("Could not verify payout bank accounts.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { destinations?: unknown } | null;
      if (!body || !Array.isArray(body.destinations)) {
        setBankLoadError("Could not verify payout bank accounts.");
        return;
      }
      const rows = body.destinations as BankAccountRow[];
      if (!rows.every((row) => typeof row.id === "string" && typeof row.last4 === "string" &&
          typeof row.payable === "boolean" && typeof row.instantEligible === "boolean" &&
          ["new", "validated", "verified", "errored", "unknown"].includes(row.status))) {
        setBankLoadError("Could not verify payout bank accounts.");
        return;
      }
      setBankRows(rows);
      setBankRoute("live");
    } catch {
      setBankLoadError("Could not verify payout bank accounts.");
    }
  }, [connectBase]);

  useEffect(() => {
    setLoading(true);
    void loadBalance();
    void loadBankAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, connectBase]);

  const closeWithdraw = useCallback(() => {
    setWithdrawOpen(false);
    setRetryRow(null);
  }, []);

  const closeBankSheet = useCallback(() => {
    setBankSheetOpen(false);
    void loadBalance();
    void loadBankAccounts();
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
      void loadBankAccounts();
      void loadBalance();
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
      void loadBankAccounts();
      void loadBalance();
    } catch {
      showToast("Could not remove that account.");
    } finally {
      setRemoveBusy(false);
    }
  }

  const effectiveBankRows: BankAccountRow[] = useMemo(
    () =>
      bankRoute === "live" && bankRows
        ? bankRows
        : balance?.bank
          ? [
              {
                id: "default",
                kind: "bank",
                label: balance.bank.bankName,
                last4: balance.bank.last4,
                status: balance.bank.verifiedAt ? "verified" : "unknown",
                payable: false,
                instantEligible: false,
                default: true,
              },
            ]
          : [],
    [bankRoute, bankRows, balance],
  );

  // Withdraw to: the default bank unless the owner picked another; the Withdraw
  // sheet opens on it (it preselects the first account it is given).
  const withdrawToDefault = effectiveBankRows.find((row) => row.default) ?? effectiveBankRows[0] ?? null;
  const withdrawToSelectedId =
    withdrawToId && effectiveBankRows.some((row) => row.id === withdrawToId) ? withdrawToId : (withdrawToDefault?.id ?? "");

  const withdrawAccounts: PayoutWithdrawAccount[] = useMemo(() => {
    const accounts: PayoutWithdrawAccount[] =
      bankRoute === "live" && bankRows
        ? bankRows
            .filter((row) => row.payable)
            .map((row) => ({
              id: row.id,
              label: row.label,
              last4: row.last4,
              kind: row.kind,
              instantEligible: row.instantEligible,
            }))
        : balance
          ? bankToWithdrawAccounts(balance.bank)
          : [];
    return [...accounts].sort(
      (a, b) => Number(b.id === withdrawToSelectedId) - Number(a.id === withdrawToSelectedId),
    );
  }, [bankRoute, bankRows, balance, withdrawToSelectedId]);

  if (loading || bankRoute === "loading") {
    return <PortalRecordListSurface loading dataAttr="payouts-settings-loading" />;
  }
  if (loadError || bankLoadError || !balance) {
    return (
      <PortalRecordListSurface
        loadError={loadError ?? bankLoadError ?? "Could not load payouts."}
        onRetry={() => {
          setLoading(true);
          void loadBalance();
          void loadBankAccounts();
        }}
        dataAttr="payouts-settings-error"
      />
    );
  }

  const ready = balance.setup.ready;
  const hasBank = effectiveBankRows.some((row) => row.payable);
  const withdrawableCents = withdrawableCentsFromSnapshot(balance);
  const removeBlocked = removeTarget != null && removeTarget.default && effectiveBankRows.length > 1;

  return (
    <div className="space-y-4" data-attr="payouts-settings-page">
      <AddBankFlow open={bankSheetOpen} onClose={closeBankSheet} portal={portal} onAdded={() => { void loadBalance(); void loadBankAccounts(); }} />
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

      <PortalSettingsSection title="PropLane balance" action={<PortalIconAction icon={ArrowUpFromLine} label="Withdraw" data-attr="payouts-settings-withdraw" disabled={!ready || !hasBank || balance.payoutReconciliationPending || withdrawableCents <= 0} onClick={() => { track("payout_withdraw_started", { portal }); setWithdrawOpen(true); }} />}>
        <PortalSettingsGroup>
          <PortalSettingsRow label="Available to withdraw"><span data-attr="payouts-settings-available">{formatMoney(withdrawableCents, balance.currency)}</span></PortalSettingsRow>
          {(balance.heldCents ?? 0) > 0 ? <PortalSettingsRow label="Held pending bank"><span data-attr="payouts-settings-held">{formatMoney(balance.heldCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {(balance.releasePendingCents ?? 0) > 0 ? <PortalSettingsRow label="Release pending"><span data-attr="payouts-settings-release-pending">{formatMoney(balance.releasePendingCents ?? 0, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.pendingCents > 0 ? <PortalSettingsRow label="Pending payments"><span data-attr="payouts-settings-payment-pending">{formatMoney(balance.pendingCents, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.onTheWayCents > 0 ? <PortalSettingsRow label="On the way"><span data-attr="payouts-settings-payout-on-way">{formatMoney(balance.onTheWayCents, balance.currency)}</span></PortalSettingsRow> : null}
          {balance.payoutReconciliationPending ? <PortalSettingsRow label="Payout status"><span>Checking a prior withdrawal</span></PortalSettingsRow> : null}

          {balance.availableNote ? <PortalSettingsRow label="Funds status"><span data-attr="payouts-settings-available-note">{balance.availableNote}</span></PortalSettingsRow> : null}
        </PortalSettingsGroup>
      </PortalSettingsSection>

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
                    {!row.default ? (
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
        onChange={(interval) => {
          setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, interval } } : current));
          void fetch(`${apiBase}/payouts/schedule`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interval }),
          })
            .then((res) => res.json().catch(() => ({})))
            .then((body: Partial<PortalPayoutBalance["schedule"]>) => {
              setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, ...body } } : current));
            })
            .catch(() => {
              showToast("Could not update the schedule.");
              void loadBalance();
            });
        }}
      /> : null}

      {/* History */}
      {portal === "manager" ? <PortalSettingsSection title="Payouts"><PortalSettingsGroup>
          {hasBank ? <PortalSettingsRow label="Withdraw to"><FieldSingleSelect label="Withdraw to" hideLabel variant="cell" value={withdrawToSelectedId} disabled={effectiveBankRows.length < 2} onChange={id => setWithdrawToId(id)} options={effectiveBankRows.map(row => ({ value: row.id, label: `${row.label} ····${row.last4}`, disabled: !row.payable }))} /></PortalSettingsRow> : null}
        {balance.history.length ? balance.history.map(row => <PortalSettingsRow key={row.id} label={formatMoney(row.amountCents, balance.currency)}>
          <span className="text-sm text-muted">{row.kind === "source_movement"
            ? row.serviceLabel ?? "Held on PropLane"
            : `${row.method === "instant" ? "Instant" : "Standard"}${row.destinationLast4 ? ` · ····${row.destinationLast4}` : ""}`}</span>
          <span className="text-sm">{row.kind === "source_movement"
            ? row.status === "paid" ? "Moved to Stripe" : row.status === "canceled" ? "Refunded" : "Captured"
            : row.status.replaceAll("_", " ")} · {formatDate(row.createdAt)}</span>
          {row.status === "failed" || row.receiptUrl ? <BankRowMenu rowId={row.id} label="Payout">
            {row.status === "failed" ? <Button variant="outline" onClick={() => { setRetryRow(row); setWithdrawOpen(true); }}>Retry</Button> : null}
            {row.receiptUrl?.startsWith("https:") ? <Button variant="outline" onClick={() => window.open(row.receiptUrl!, "_blank", "noopener")}>Receipt</Button> : null}
          </BankRowMenu> : null}
        </PortalSettingsRow>) : <PortalSettingsRow label="No payouts yet" />}
      </PortalSettingsGroup></PortalSettingsSection> : <HistorySection
        rows={balance.history}
        currency={balance.currency}
        search=""
        onClearSearch={() => {}}
        portal={portal}
        onReceipt={(row) => {
          if (row.receiptUrl && row.receiptUrl.startsWith("https:")) {
            window.open(row.receiptUrl, "_blank", "noopener");
          }
        }}
        onRetry={(row) => {
          // Same as portal-payouts-panel.tsx's own Retry — route through the
          // SAME confirmation sheet a fresh Withdraw uses, prefilled with the
          // failed row's own (gross) amount/method, never a one-click resend.
          track("payout_withdraw_started", { portal, retry: true });
          setRetryRow(row);
          setWithdrawOpen(true);
        }}
      />}

      {portal === "manager" && creditPurchases.length ? <PortalSettingsSection title="Payments activity"><PortalSettingsGroup>
        {creditPurchases.map(purchase => <PortalSettingsRow key={purchase.id} label="Messaging credit"><span className="text-sm text-muted">{formatDate(purchase.createdAt)} · Card · {purchase.status === "paid" ? "Paid" : purchase.status.replaceAll("_", " ")}</span><span >{formatMoney(purchase.creditCents, "usd")}</span></PortalSettingsRow>)}
      </PortalSettingsGroup></PortalSettingsSection> : null}

      <PayoutWithdrawSheet
        heldDepositCents={balance.heldDepositCents}
        open={withdrawOpen}
        onClose={closeWithdraw}
        apiBase={apiBase}
        currency={balance.currency}
        availableCents={withdrawableCents}
        instantAvailableCents={balance.instantAvailableCents}
        accounts={withdrawAccounts}
        initialAmountCents={retryRow?.amountCents}
        initialMethod={retryRow?.method ?? undefined}
        onSuccess={(result) => {
          closeWithdraw();
          track("payout_withdraw_completed", { portal, method: result.method, amount_cents: result.amountCents });
          void loadBalance();
        }}
      />

      {/* VD55/VD68 — vendor-only, inert (renders null) until VENDOR_BANKING_ENABLED
          is on. Owned by night/vendor-banking; touches only this appended
          section, never the Payouts card above it. */}
      {portal === "vendor" ? <VendorPayoutsSettingsExtra balance={balance} /> : null}
    </div>
  );
}
