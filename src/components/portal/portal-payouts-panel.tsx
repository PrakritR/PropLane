"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUp, Calendar, Landmark, Settings, Wrench, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { PortalPayoutSetupCard, type PortalPayoutSetupStatus } from "@/components/portal/portal-payout-setup-card";
import { PortalPayOutSheet } from "@/components/portal/portal-pay-out-sheet";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { track } from "@/lib/analytics/track-client";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { cn } from "@/lib/utils";

export type PortalPayoutsPortalKind = "manager" | "vendor";

export type PortalPayoutScheduleInterval = "daily" | "weekly" | "monthly" | "manual";

export type PortalPayoutHistoryRow = {
  id: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  method: "standard" | "instant";
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled" | "returned";
  destinationLast4: string;
  createdAt: string;
  arrivalDate: string | null;
  initiatedInApp: boolean;
  failureMessage: string | null;
  serviceLabel: string | null;
  /** Not on the base contract yet — read defensively; the ⋯ Receipt item only ever shows when a server sends this. */
  receiptUrl?: string | null;
};

export type PortalPayoutBank = {
  last4: string;
  bankName: string;
  accountType: string;
  instantEligible: boolean;
  verifiedAt: string | null;
};

export type PortalPayoutBalance = {
  currency: string;
  availableCents: number;
  instantAvailableCents: number;
  pendingCents: number;
  onTheWayCents: number;
  bank: PortalPayoutBank | null;
  schedule: {
    interval: PortalPayoutScheduleInterval;
    weeklyAnchor?: string;
    monthlyAnchor?: number;
    nextPayoutAt: string | null;
  };
  setup: PortalPayoutSetupStatus;
  history: PortalPayoutHistoryRow[];
  /** The saved Stripe account could not be reached; the setup card offers Reconnect. */
  needsRelink?: boolean;
};

const PORTAL_API_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe",
  vendor: "/api/vendor",
};

const PORTAL_CONNECT_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe/connect",
  vendor: "/api/vendor/stripe-connect",
};

const SCHEDULE_OPTIONS: { value: PortalPayoutScheduleInterval; label: string }[] = [
  { value: "weekly", label: "Every Friday" },
  { value: "daily", label: "Every day" },
  { value: "monthly", label: "Every month" },
  { value: "manual", label: "Manual" },
];

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(
    cents / 100,
  );
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function capitalize(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** A per-row ⋯ that owns its own scope — mirrors `BookingsRowOverflow`, the shared way to give one record its own menu outside a bulk-select list. */
function PayoutRowMenu({ rowId, label, children }: { rowId: string; label: string; children: ReactNode }) {
  return (
    <RecordActionContext.Provider value={{ scope: rowId, clear: () => {}, actions: children }}>
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

function PayoutBalanceCard({ balance, onPayOut }: { balance: PortalPayoutBalance; onPayOut: () => void }) {
  const nextPayout = formatDate(balance.schedule.nextPayoutAt);
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm" data-attr="payouts-balance-card">
      <div className="flex flex-wrap items-end justify-between gap-4 max-md:flex-col max-md:items-stretch">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Available now</p>
          <p className="mt-1 text-[32px] font-extrabold leading-none tracking-tight text-foreground" data-attr="payouts-available">
            {formatMoney(balance.availableCents, balance.currency)}
          </p>
        </div>
        <Button
          type="button"
          onClick={onPayOut}
          disabled={balance.availableCents <= 0}
          data-attr="payouts-pay-out-open"
          className="max-md:w-full"
        >
          Pay out
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted">
        <PortalRowFact icon={Landmark}>
          On the way {formatMoney(balance.onTheWayCents, balance.currency)}
          {nextPayout ? ` · arrives ${nextPayout}` : ""}
        </PortalRowFact>
        <PortalRowFact icon={Zap}>Clearing {formatMoney(balance.pendingCents, balance.currency)}</PortalRowFact>
      </div>
    </div>
  );
}

function GetsPaidToCard({ bank, onChangeBank }: { bank: PortalPayoutBank | null; onChangeBank: () => void }) {
  return (
    <PortalSettingsSection title="Gets paid to">
      <PortalSettingsGroup>
        {bank ? (
          <div className="flex items-center gap-3 px-4 py-3.5">
            <div
              aria-hidden
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/[0.08] text-primary"
            >
              <Landmark className="size-5" strokeWidth={1.6} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">
                {bank.bankName} ····{bank.last4}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
                <span>{capitalize(bank.accountType)}</span>
                {bank.instantEligible ? <PortalRowFact icon={Zap}>Instant eligible</PortalRowFact> : null}
                {bank.verifiedAt ? <PortalRowFact icon={ArrowUp}>Verified {formatDate(bank.verifiedAt)}</PortalRowFact> : null}
              </p>
            </div>
            <PayoutRowMenu rowId="gets-paid-to" label="Bank account">
              <Button type="button" variant="outline" onClick={onChangeBank} data-attr="payouts-change-bank">
                Change bank
              </Button>
            </PayoutRowMenu>
          </div>
        ) : (
          <div className="px-4 py-3.5 text-sm text-muted">No bank linked</div>
        )}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

function ScheduleCard({
  schedule,
  availableCents,
  currency,
  onChange,
}: {
  schedule: PortalPayoutBalance["schedule"];
  availableCents: number;
  currency: string;
  onChange: (interval: PortalPayoutScheduleInterval) => void;
}) {
  const nextPayout = formatDate(schedule.nextPayoutAt);
  return (
    <PortalSettingsSection title="Schedule">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Automatic payout">
          <FieldSingleSelect
            label="Automatic payout"
            hideLabel
            value={schedule.interval}
            options={SCHEDULE_OPTIONS}
            onChange={(next) => onChange(next as PortalPayoutScheduleInterval)}
            dataAttr="payouts-schedule-select"
          />
        </PortalSettingsRow>
        <PortalSettingsRow label="Next payout">
          <span className="text-sm text-foreground">
            {schedule.interval === "manual"
              ? "Manual"
              : nextPayout
                ? `${nextPayout} · ${formatMoney(availableCents, currency)}`
                : "—"}
          </span>
        </PortalSettingsRow>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

function payoutMethodLabel(method: "standard" | "instant"): string {
  return method === "instant" ? "Instant" : "Standard";
}

function PayoutHistoryRow({
  row,
  currency,
  portal,
  onReceipt,
  onRetry,
}: {
  row: PortalPayoutHistoryRow;
  currency: string;
  portal: PortalPayoutsPortalKind;
  onReceipt: (row: PortalPayoutHistoryRow) => void;
  onRetry: (row: PortalPayoutHistoryRow) => void;
}) {
  const isReturned = row.status === "returned" || row.status === "failed";
  const TileIcon = row.method === "instant" ? Zap : ArrowUp;
  const sentDate = formatDate(row.createdAt);
  const arrivedDate = row.status === "paid" ? formatDate(row.arrivalDate) : null;
  const arrivesDate = row.status === "pending" || row.status === "in_transit" ? formatDate(row.arrivalDate) : null;
  const returnedDate = formatDate(row.arrivalDate) ?? sentDate;
  const hasReceipt = Boolean(row.receiptUrl);
  const canRetry = row.status === "failed";
  const rowLabel = `${payoutMethodLabel(row.method)} payout of ${formatMoney(row.amountCents, currency)}`;

  return (
    <PortalPropertyRecordRow
      title={formatMoney(row.amountCents, currency)}
      address={`${payoutMethodLabel(row.method)} · Bank ····${row.destinationLast4}`}
      leading={
        <div
          aria-hidden
          className={cn(
            "grid h-[4.125rem] w-[4.125rem] place-items-center rounded-[10px] max-md:h-[3.125rem] max-md:w-[3.125rem]",
            isReturned ? "bg-[color-mix(in_srgb,var(--status-danger-fg,#dc2626)_12%,transparent)] text-[var(--status-danger-fg,#dc2626)]" : "bg-accent/60 text-muted",
          )}
        >
          <TileIcon className="size-5" strokeWidth={1.75} />
        </div>
      }
      facts={
        <>
          {sentDate ? <PortalRowFact icon={Calendar}>Sent {sentDate}</PortalRowFact> : null}
          {arrivedDate ? <PortalRowFact icon={Landmark}>Arrived {arrivedDate}</PortalRowFact> : null}
          {arrivesDate ? <PortalRowFact icon={Landmark}>Arrives {arrivesDate}</PortalRowFact> : null}
          {row.method === "instant" ? <PortalRowFact icon={Zap}>Fee {formatMoney(row.feeCents, currency)}</PortalRowFact> : null}
          {isReturned ? (
            <PortalRowFact icon={AlertTriangle}>
              Returned by the bank {returnedDate ?? ""} · back in Available
            </PortalRowFact>
          ) : null}
          {portal === "vendor" && row.serviceLabel ? <PortalRowFact icon={Wrench}>{row.serviceLabel}</PortalRowFact> : null}
        </>
      }
      trailing={
        hasReceipt || canRetry ? (
          <PayoutRowMenu rowId={row.id} label={rowLabel}>
            {hasReceipt ? (
              <Button type="button" variant="outline" onClick={() => onReceipt(row)} data-attr="payouts-history-receipt">
                Receipt
              </Button>
            ) : null}
            {canRetry ? (
              <Button type="button" variant="outline" onClick={() => onRetry(row)} data-attr="payouts-history-retry">
                Retry
              </Button>
            ) : null}
          </PayoutRowMenu>
        ) : undefined
      }
      dataAttr="payouts-history-row"
    />
  );
}

function HistorySection({
  rows,
  currency,
  search,
  onClearSearch,
  portal,
  onReceipt,
  onRetry,
}: {
  rows: PortalPayoutHistoryRow[];
  currency: string;
  search: string;
  onClearSearch: () => void;
  portal: PortalPayoutsPortalKind;
  onReceipt: (row: PortalPayoutHistoryRow) => void;
  onRetry: (row: PortalPayoutHistoryRow) => void;
}) {
  const filtered = rows.filter((row) =>
    matchesPortalListSearch(
      search,
      payoutMethodLabel(row.method),
      row.destinationLast4,
      row.status,
      row.serviceLabel,
      formatMoney(row.amountCents, currency),
    ),
  );
  const isEmpty = filtered.length === 0;
  return (
    <div>
      <h2 className="mb-2 px-1 text-[15px] font-bold tracking-[-0.01em] text-foreground">History</h2>
      <PortalRecordListSurface
        isEmpty={isEmpty}
        dataAttr="payouts-history"
        emptyCard={{
          title: rows.length === 0 ? "No payouts yet" : "No matching payouts",
          section: "payments",
          clear: rows.length > 0 && search ? { label: "Clear search", onClick: onClearSearch } : null,
        }}
      >
        {filtered.map((row) => (
          <PayoutHistoryRow key={row.id} row={row} currency={currency} portal={portal} onReceipt={onReceipt} onRetry={onRetry} />
        ))}
      </PortalRecordListSurface>
    </div>
  );
}

function PayoutsChrome({
  portal,
  search,
  onSearchChange,
  onOpenSettings,
  children,
}: {
  portal: PortalPayoutsPortalKind;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  const commandBar = (
    <PortalListControlStack
      className="mb-3"
      variant="command"
      search={{ value: search, onChange: onSearchChange, placeholder: "Search payouts", dataAttr: "payouts-search" }}
      actions={<PortalIconAction icon={Settings} label="Payout settings" data-attr="payouts-settings" onClick={onOpenSettings} />}
    />
  );
  // Vendor mounts inside Vendor Finances' own Income/Invoices/Payouts chrome
  // (`VendorFinancesChrome`), which already owns the page shell — a second
  // one here would nest two page titles.
  if (portal === "vendor") {
    return (
      <div className="space-y-3">
        {commandBar}
        {children}
      </div>
    );
  }
  return (
    <ManagerPortalPageShell title="Payments" hideTitleOnMobileNav compactFilterRow>
      {commandBar}
      {children}
    </ManagerPortalPageShell>
  );
}

/**
 * The Payouts page — one balance, one Pay out button, the bank it lands in,
 * the automatic schedule, and the payout history — mounted for both the
 * manager (`/portal/payments/payouts`) and the vendor
 * (`/vendor/financials/payouts`) with the same panel (PLAN-0920-0853).
 */
export function PortalPayoutsPanel({ portal }: { portal: PortalPayoutsPortalKind }) {
  const { showToast } = useAppUi();
  const apiBase = PORTAL_API_BASE[portal];
  const connectBase = PORTAL_CONNECT_BASE[portal];

  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [payOutOpen, setPayOutOpen] = useState(false);
  const [retryRow, setRetryRow] = useState<PortalPayoutHistoryRow | null>(null);
  const [bankSettingsOpen, setBankSettingsOpen] = useState(false);

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

  useEffect(() => {
    setLoading(true);
    void loadBalance();
    // Re-run once per mount only — a schedule/pay-out action reloads itself explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const handleScheduleChange = useCallback(
    async (interval: PortalPayoutScheduleInterval) => {
      setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, interval } } : current));
      try {
        const res = await fetch(`${apiBase}/payouts/schedule`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval }),
        });
        const body = (await res.json().catch(() => ({}))) as Partial<PortalPayoutBalance["schedule"]> & { error?: string };
        if (!res.ok) {
          showToast(body.error ?? "Could not update the schedule.");
          void loadBalance();
          return;
        }
        setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, ...body } } : current));
        track("payout_schedule_changed", { portal, interval });
      } catch {
        showToast("Could not update the schedule.");
        void loadBalance();
      }
    },
    [apiBase, loadBalance, portal, showToast],
  );

  const handleReceipt = useCallback((row: PortalPayoutHistoryRow) => {
    // A receipt link is only ever safe to open when it is actually an
    // outbound https URL — never `javascript:`/`data:`/relative-scheme
    // trickery from a row shape this client does not fully control.
    if (row.receiptUrl && row.receiptUrl.startsWith("https:")) {
      window.open(row.receiptUrl, "_blank", "noopener");
    }
  }, []);

  // Retry is an outward money movement, not a re-fetch — it must go through
  // the SAME confirmation sheet a fresh "Pay out" does rather than firing a
  // one-click POST from a row's ⋯ menu. The sheet prefills the failed row's
  // own amount/method (both GROSS — see `PortalPayOutSheet`'s doc comment)
  // and the user still has to press "Pay out $X" to confirm.
  const handleRetry = useCallback((row: PortalPayoutHistoryRow) => {
    setRetryRow(row);
    setPayOutOpen(true);
  }, []);

  const closePayOut = useCallback(() => {
    setPayOutOpen(false);
    setRetryRow(null);
  }, []);

  const closeBankSettings = useCallback(() => {
    setBankSettingsOpen(false);
    void loadBalance();
  }, [loadBalance]);

  let content: ReactNode;
  if (loading) {
    content = <PortalRecordListSurface loading dataAttr="payouts-loading" />;
  } else if (loadError) {
    content = (
      <PortalRecordListSurface
        loadError={loadError}
        onRetry={() => {
          setLoading(true);
          void loadBalance();
        }}
        dataAttr="payouts-error"
      />
    );
  } else if (!balance) {
    content = null;
  } else if (balance.needsRelink || !balance.setup.ready) {
    content = (
      <PortalPayoutSetupCard
        connectBase={connectBase}
        setup={balance.setup}
        needsRelink={balance.needsRelink === true}
        onReady={() => void loadBalance()}
      />
    );
  } else {
    content = (
      <div className="space-y-4">
        <PayoutBalanceCard
          balance={balance}
          onPayOut={() => {
            track("payout_started", { portal });
            setPayOutOpen(true);
          }}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <GetsPaidToCard bank={balance.bank} onChangeBank={() => setBankSettingsOpen(true)} />
          <ScheduleCard
            schedule={balance.schedule}
            availableCents={balance.availableCents}
            currency={balance.currency}
            onChange={handleScheduleChange}
          />
        </div>
        <HistorySection
          rows={balance.history}
          currency={balance.currency}
          search={search}
          onClearSearch={() => setSearch("")}
          portal={portal}
          onReceipt={handleReceipt}
          onRetry={handleRetry}
        />
        <PortalPayOutSheet
          open={payOutOpen}
          onClose={closePayOut}
          apiBase={apiBase}
          currency={balance.currency}
          availableCents={balance.availableCents}
          instantAvailableCents={balance.instantAvailableCents}
          bank={balance.bank}
          initialAmountCents={retryRow?.amountCents}
          initialMethod={retryRow?.method}
          onSuccess={(result) => {
            closePayOut();
            track("payout_completed", { portal, method: result.method, amount_cents: result.amountCents });
            void loadBalance();
          }}
        />
      </div>
    );
  }

  return (
    <PayoutsChrome portal={portal} search={search} onSearchChange={setSearch} onOpenSettings={() => setBankSettingsOpen(true)}>
      {content}
      <Modal open={bankSettingsOpen} title="Bank account" onClose={closeBankSettings} panelClassName="max-w-lg" scrollableContent={false}>
        <StripeConnectEmbedded connectBase={connectBase} component="account_management" onExit={closeBankSettings} />
      </Modal>
    </PayoutsChrome>
  );
}
