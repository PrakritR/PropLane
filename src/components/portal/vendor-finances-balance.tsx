"use client";

/**
 * Vendor Finances → Balance & payouts (vendor-banking-1006, part A).
 *
 * ONE server snapshot (`GET /api/vendor/payouts/balance`) feeds every number
 * here: Available · Pending · Held (with its reason) · On the way · Owed to
 * PropLane all come through `deriveVendorFinancesFigures`. The banner above the
 * figures names the exact reason money cannot move and offers the one fix.
 * Header icons are Bank and Withdraw only. Below: the payout history (each row
 * opens a detail page with a receipt) and the Withdraw sheet, which quotes the
 * Instant fee from the one constant and guards against a double submit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowUpFromLine, Calendar, FileText, Landmark, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalRecordActions, PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { AddBankFlow } from "@/components/portal/add-bank-flow";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { isPayoutDestinationSummary, type PayoutDestinationSummary } from "@/components/portal/payout-bank-sheet";
import {
  formatDate,
  formatMoney,
  isPortalPayoutBalance,
  type PortalPayoutBalance,
  type PortalPayoutHistoryRow,
} from "@/components/portal/portal-payouts-panel";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { sharedGet } from "@/lib/shared-get-cache";
import { track } from "@/lib/analytics/track-client";
import { VENDOR_INSTANT_WITHDRAW_FEE_LABEL, vendorInstantWithdrawFeeQuoteCents } from "@/lib/platform-fees";
import {
  deriveVendorFinancesBanner,
  deriveVendorFinancesFigures,
  vendorWithdrawableCents,
  vendorWithdrawDisabledReason,
} from "@/lib/vendor-banking/finances";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "relink"; balance: null }
  | { status: "ready"; balance: PortalPayoutBalance; banks: PayoutDestinationSummary[] };

/** A balance snapshot read for a vendor with a Stripe account that can no longer be reached. */
const RELINK_SNAPSHOT: PortalPayoutBalance = {
  currency: "usd",
  availableCents: 0,
  instantAvailableCents: 0,
  pendingCents: 0,
  onTheWayCents: 0,
  heldCents: 0,
  releasePendingCents: 0,
  recoveryOutstandingCents: 0,
  recoveryReservedCents: 0,
  withdrawableCents: 0,
  bank: null,
  schedule: { interval: "manual", nextPayoutAt: null },
  setup: { ready: false, identity: "needed", bank: "needed" } as PortalPayoutBalance["setup"],
  history: [],
  needsRelink: true,
};

function payoutTitle(row: PortalPayoutHistoryRow): string {
  const method = row.method === "instant" ? "Instant payout" : "Standard payout";
  return row.kind === "source_movement" ? "Moved to Stripe" : method;
}

function payoutStateLabel(row: PortalPayoutHistoryRow): string {
  const state = row.status.replaceAll("_", " ");
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function useVendorBalance() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const run = ++sequence.current;
    const [balanceRead, banksRead] = await Promise.all([
      sharedGet("/api/vendor/payouts/balance", { ttlMs: 0 }),
      sharedGet("/api/vendor/stripe-connect/bank-accounts", { ttlMs: 0 }),
    ]);
    if (run !== sequence.current) return;
    if (!balanceRead.ok && balanceRead.status === 409) {
      setState({ status: "relink", balance: null });
      return;
    }
    const bankBody = banksRead.ok ? (banksRead.data as { destinations?: unknown } | null) : null;
    if (
      !balanceRead.ok ||
      !isPortalPayoutBalance(balanceRead.data) ||
      !bankBody ||
      !Array.isArray(bankBody.destinations) ||
      !bankBody.destinations.every(isPayoutDestinationSummary)
    ) {
      setState({ status: "error", message: "Could not load your balance." });
      return;
    }
    setState({ status: "ready", balance: balanceRead.data, banks: bankBody.destinations });
  }, []);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  return { state, reload };
}

export function VendorBalancePanel({ basePath }: { basePath: string }) {
  const navigate = usePortalNavigate();
  const { state, reload } = useVendorBalance();
  const [addBankOpen, setAddBankOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [retryRow, setRetryRow] = useState<PortalPayoutHistoryRow | null>(null);

  const snapshot = state.status === "ready" ? state.balance : state.status === "relink" ? RELINK_SNAPSHOT : null;
  const readyBanks = state.status === "ready" ? state.banks : null;

  const withdrawAccounts: PayoutWithdrawAccount[] = useMemo(
    () =>
      (readyBanks ?? [])
        .filter((row) => row.payable)
        .sort((a, b) => Number(b.default) - Number(a.default))
        .map((row) => ({ id: row.id, label: row.label, last4: row.last4, kind: row.kind, instantEligible: row.instantEligible })),
    [readyBanks],
  );

  const figures = snapshot ? deriveVendorFinancesFigures(snapshot) : null;
  const banner = snapshot && figures ? deriveVendorFinancesBanner(snapshot, figures.heldCents) : null;
  const disabledReason = snapshot ? vendorWithdrawDisabledReason(snapshot, withdrawAccounts.length > 0) : null;
  const instantFee = useMemo(
    () => ({ label: VENDOR_INSTANT_WITHDRAW_FEE_LABEL, quoteCents: vendorInstantWithdrawFeeQuoteCents }),
    [],
  );

  const history = useMemo(
    () => (snapshot?.history ?? []).filter((row) => row.kind !== "source_movement"),
    [snapshot],
  );

  function onBannerAction(action: "add-bank" | "verify" | "relink" | null) {
    if (action === "relink") navigate(`${basePath}/profile?tab=payouts`);
    else if (action) setAddBankOpen(true);
  }

  return (
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
      {state.status === "loading" ? (
        <PortalRecordListSurface loading dataAttr="vendor-balance-loading" />
      ) : state.status === "error" ? (
        <PortalRecordListSurface loadError={state.message} onRetry={reload} dataAttr="vendor-balance-error" />
      ) : snapshot && figures ? (
        <>
          {banner ? (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-accent/50 px-3 py-2.5 text-sm"
              data-attr="vendor-balance-banner"
            >
              <span className="text-foreground">{banner.message}</span>
              {banner.action && banner.actionLabel ? (
                <Button type="button" variant="outline" onClick={() => onBannerAction(banner.action)} data-attr="vendor-balance-banner-action">
                  {banner.actionLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3 rounded-[10px] border border-border bg-card p-4" data-attr="vendor-balance-card">
            <div className="flex flex-1 flex-wrap gap-6">
              <Figure label="Available" cents={figures.availableCents} dataAttr="vendor-balance-available" />
              <Figure label="Pending" cents={figures.pendingCents} dataAttr="vendor-balance-pending" />
              <Figure label="Held" cents={figures.heldCents} note={figures.heldReason} dataAttr="vendor-balance-held" />
              <Figure label="On the way" cents={figures.onTheWayCents} dataAttr="vendor-balance-on-the-way" />
              {figures.owedToPropLaneCents > 0 ? (
                <Figure label="Owed to PropLane" cents={figures.owedToPropLaneCents} tone="danger" dataAttr="vendor-balance-owed" />
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <PortalIconAction icon={Landmark} label="Bank" data-attr="vendor-balance-bank" onClick={() => setAddBankOpen(true)} />
              <PortalIconAction
                icon={ArrowUpFromLine}
                label={disabledReason ? `Withdraw — ${disabledReason}` : "Withdraw"}
                data-attr="vendor-balance-withdraw"
                disabled={disabledReason !== null}
                onClick={() => {
                  track("payout_withdraw_started", { portal: "vendor", source: "finances_balance" });
                  setRetryRow(null);
                  setWithdrawOpen(true);
                }}
              />
            </div>
          </div>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            destinations={[
              {
                id: "payouts",
                label: "Payouts",
                count: history.length,
                href: `${basePath}/financials/balance`,
                dataAttr: "vendor-balance-tab-payouts",
              },
            ]}
            activeDestinationId="payouts"
            destinationAriaLabel="Payout history"
          />
          <PortalRecordListSurface
            isEmpty={history.length === 0}
            dataAttr="vendor-payout-history"
            emptyCard={{ title: "No payouts yet", section: "financials", tone: "muted" }}
          >
            {history.map((row) => (
              <PortalPropertyRecordRow
                key={row.id}
                title={payoutTitle(row)}
                address={row.destinationLast4 ? `Bank ····${row.destinationLast4}` : undefined}
                leading={
                  <span className="grid size-14 place-items-center rounded-xl bg-accent/60 text-muted" aria-hidden>
                    {row.method === "instant" ? <Zap className="size-5" strokeWidth={1.75} /> : <ArrowUp className="size-5" strokeWidth={1.75} />}
                  </span>
                }
                leadingShape="square"
                facts={
                  <>
                    <PortalRowFact icon={Calendar} srLabel="Sent">{formatDate(row.createdAt)}</PortalRowFact>
                    <span>{payoutStateLabel(row)}</span>
                    {row.method === "instant" && row.feeCents > 0 ? <PortalRowFact icon={Zap} srLabel="Fee">Fee {formatMoney(row.feeCents, snapshot.currency)}</PortalRowFact> : null}
                  </>
                }
                amount={formatMoney(row.amountCents, snapshot.currency)}
                amountTone={row.status === "failed" || row.status === "returned" ? "bad" : undefined}
                actions={
                  row.status === "failed" && !snapshot.payoutReconciliationPending ? (
                    <VendorRowMenu
                      label={payoutTitle(row)}
                      dataAttr="vendor-payout-row-menu"
                      items={[
                        {
                          id: "retry",
                          label: "Retry",
                          disabled: disabledReason !== null,
                          onSelect: () => {
                            track("payout_withdraw_started", { portal: "vendor", retry: true });
                            setRetryRow(row);
                            setWithdrawOpen(true);
                          },
                        },
                      ]}
                    />
                  ) : undefined
                }
                onOpen={() => navigate(`${basePath}/financials/balance/${encodeURIComponent(row.id)}`)}
                dataAttr="vendor-payout-history-row"
              />
            ))}
          </PortalRecordListSurface>
          <PayoutWithdrawSheet
            open={withdrawOpen}
            onClose={() => {
              setWithdrawOpen(false);
              setRetryRow(null);
            }}
            apiBase="/api/vendor"
            currency={snapshot.currency}
            availableCents={vendorWithdrawableCents(snapshot)}
            instantAvailableCents={snapshot.instantAvailableCents}
            accounts={withdrawAccounts}
            instantFee={typeof snapshot.feeBps === "number" ? instantFee : undefined}
            initialAmountCents={retryRow?.amountCents}
            initialMethod={retryRow?.method ?? undefined}
            onSuccess={(result) => {
              setWithdrawOpen(false);
              setRetryRow(null);
              track("payout_withdraw_completed", { portal: "vendor", method: result.method, amount_cents: result.amountCents });
              reload();
            }}
          />
        </>
      ) : null}
      <AddBankFlow
        open={addBankOpen}
        onClose={() => {
          setAddBankOpen(false);
          reload();
        }}
        portal="vendor"
        onAdded={() => reload()}
      />
    </ManagerPortalPageShell>
  );
}

function Figure({
  label,
  cents,
  note,
  tone,
  dataAttr,
}: {
  label: string;
  cents: number;
  note?: string | null;
  tone?: "danger";
  dataAttr: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-extrabold leading-none tracking-tight ${tone === "danger" ? "text-danger" : "text-foreground"}`}
        data-attr={dataAttr}
      >
        {formatMoney(cents, "usd")}
      </p>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}

/** One withdrawal's own page: the amounts, where it went, when it lands, and a printable receipt. */
export function VendorWithdrawalDetail({ basePath, withdrawalId }: { basePath: string; withdrawalId: string }) {
  const { state, reload } = useVendorBalance();
  const backHref = `${basePath}/financials/balance`;

  if (state.status === "loading") {
    return <PortalRecordListSurface loading dataAttr="vendor-withdrawal-loading" />;
  }
  if (state.status === "error" || state.status === "relink") {
    return (
      <PortalRecordListSurface
        loadError={state.status === "error" ? state.message : "Reconnect your Stripe account to view payouts."}
        onRetry={reload}
        dataAttr="vendor-withdrawal-error"
      />
    );
  }
  const row = state.balance.history.find((item) => item.id === withdrawalId && item.kind !== "source_movement") ?? null;
  if (!row) {
    return <PortalRecordListSurface isEmpty emptyCard={{ title: "Payout not found", section: "financials", tone: "muted" }} dataAttr="vendor-withdrawal-missing" />;
  }
  const currency = state.balance.currency;
  const fee = row.method === "instant" ? Math.max(0, row.feeCents) : 0;
  const title = `${payoutTitle(row)} · ${formatMoney(row.amountCents, currency)}`;

  return (
    <PortalRecordDetailPage
      pageTitle="Finances"
      title={title}
      subtitle="Payout"
      avatarName={title}
      backHref={backHref}
      backLabel="Back to balance"
      hideBackText
      bareHeader
      iconTitleActions
      pinScrollBody
    >
      <PortalRecordActions>
        <PortalIconAction
          icon={FileText}
          label="Receipt"
          ring
          data-attr="vendor-withdrawal-receipt"
          onClick={() => window.open(`/print/vendor-withdrawal/${encodeURIComponent(row.id)}`, "_blank", "noopener")}
        />
      </PortalRecordActions>
      <div className="px-3 pb-4 sm:px-4" data-attr="vendor-withdrawal-detail">
        <PortalSettingsSection title="Payout">
          <PortalSettingsGroup>
            <PortalSettingsRow label="Amount">{formatMoney(row.amountCents, currency)}</PortalSettingsRow>
            {fee > 0 ? <PortalSettingsRow label="Instant payout fee">−{formatMoney(fee, currency)}</PortalSettingsRow> : null}
            <PortalSettingsRow label="Sent to your bank">{formatMoney(row.amountCents - fee, currency)}</PortalSettingsRow>
            <PortalSettingsRow label="To">{row.destinationLast4 ? `Bank ····${row.destinationLast4}` : "Your payout account"}</PortalSettingsRow>
            <PortalSettingsRow label="Sent">{formatDate(row.createdAt) ?? "—"}</PortalSettingsRow>
            <PortalSettingsRow label={row.status === "paid" ? "Arrived" : "Arrives"}>{formatDate(row.arrivalDate) ?? "—"}</PortalSettingsRow>
            <PortalSettingsRow label="Status">{payoutStateLabel(row)}</PortalSettingsRow>
            {row.failureMessage ? <PortalSettingsRow label="Reason">{row.failureMessage}</PortalSettingsRow> : null}
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </div>
    </PortalRecordDetailPage>
  );
}
