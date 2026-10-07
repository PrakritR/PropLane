"use client";

import { type ReactNode } from "react";
import { AlertTriangle, ArrowUp, Calendar, Landmark, Wrench, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { type PortalPayoutSetupStatus } from "@/components/portal/portal-payout-setup-card";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { cn } from "@/lib/utils";

/**
 * Payouts is one page now, mounted at Profile → Payouts
 * (`portal-payouts-settings-page.tsx`, PLAN-0920-1500 / PLAN-0920-2024) for both
 * the manager (`/portal/profile?tab=payouts`) and the vendor (`Vendor → Settings →
 * Payouts`). This file no longer owns a page — `render-portal-section.tsx`
 * and `vendor-finances-panel.tsx` redirect the old `/payments/payouts` /
 * `/financials/payouts` paths straight to it. What survives here are the
 * pieces the settings page mounts: shared types, formatters, `ScheduleCard`
 * and `HistorySection`.
 */

export type PortalPayoutsPortalKind = "manager" | "vendor";

export type PortalPayoutScheduleInterval = "daily" | "weekly" | "monthly" | "manual";

export type PortalPayoutHistoryRow = {
  id: string;
  kind?: "source_movement";
  amountCents: number;
  feeCents: number;
  netCents: number;
  method: "standard" | "instant" | null;
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled" | "returned";
  destinationLast4: string | null;
  createdAt: string;
  arrivalDate: string | null;
  initiatedInApp: boolean;
  failureMessage: string | null;
  serviceLabel: string | null;
  /** Historical data only. External provider URLs are not a portal receipt surface. */
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
  heldDepositCents?: number;
  currency: string;
  availableCents: number;
  instantAvailableCents: number;
  pendingCents: number;
  onTheWayCents: number;
  payoutReconciliationPending?: boolean;
  heldCents?: number;
  releasePendingCents?: number;
  recoveryOutstandingCents?: number;
  recoveryReservedCents?: number;
  withdrawableCents?: number;
  /** Cents frozen by an open dispute (server-read). Already subtracted from `availableCents`, never from `withdrawableCents`. */
  frozenDisputeCents?: number;
  availableNote?: string;
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
  /** VENDOR_BANKING_ENABLED — present (and > 0) only once the vendor take rate is on. */
  feeBps?: number;
  /** Vendor refund path live (`VENDOR_REFUNDS_ENABLED`) — gates the Payments row's Refund item. */
  refundsEnabled?: boolean;
};

/** Money actions require a complete current provider snapshot, including the signed provider balance. */
export function isPortalPayoutBalance(value: unknown): value is PortalPayoutBalance {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PortalPayoutBalance>;
  return row.currency === "usd" &&
    [row.availableCents, row.withdrawableCents, row.instantAvailableCents,
      row.pendingCents, row.onTheWayCents, row.heldCents, row.releasePendingCents,
      row.recoveryOutstandingCents, row.recoveryReservedCents]
      .every((amount) => Number.isSafeInteger(amount)) &&
    !!row.setup && typeof row.setup.ready === "boolean" &&
    !!row.schedule && Array.isArray(row.history);
}

const SCHEDULE_OPTIONS: { value: PortalPayoutScheduleInterval; label: string }[] = [
  { value: "weekly", label: "Every Friday" },
  { value: "daily", label: "Every day" },
  { value: "monthly", label: "Every month" },
  { value: "manual", label: "Manual" },
];

/**
 * VENDOR_BANKING_ENABLED — vendor Connect accounts default to manual payouts
 * (money leaves only when the vendor presses Withdraw); the Settings toggle
 * offers only the two schedules the vendor-banking decision brief names
 * ("Only when I withdraw / Weekly"), never daily/monthly, which were never
 * part of that decision and would payout automatically before the vendor
 * asked. Manager schedule options (`SCHEDULE_OPTIONS`) are untouched.
 */
const VENDOR_SCHEDULE_OPTIONS: { value: PortalPayoutScheduleInterval; label: string }[] = [
  { value: "manual", label: "Only when I withdraw" },
  { value: "weekly", label: "Weekly" },
];

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(
    cents / 100,
  );
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A per-row ⋯ that owns its own scope — mirrors `BookingsRowOverflow`, the shared way to give one record its own menu outside a bulk-select list. */
function PayoutRowMenu({ rowId, label, children }: { rowId: string; label: string; children: ReactNode }) {
  return (
    <RecordActionContext.Provider value={{ scope: rowId, clear: () => {}, actions: children }}>
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

/** Exported so `portal-payouts-settings-page.tsx`'s Schedule section mounts the identical control. */
export function ScheduleCard({
  schedule,
  availableCents,
  currency,
  onChange,
  portal = "manager",
}: {
  schedule: PortalPayoutBalance["schedule"];
  availableCents: number;
  currency: string;
  onChange: (interval: PortalPayoutScheduleInterval) => void;
  /** VD68 — vendor Connect accounts pick from `VENDOR_SCHEDULE_OPTIONS` only. */
  portal?: PortalPayoutsPortalKind;
}) {
  const nextPayout = formatDate(schedule.nextPayoutAt);
  const options = portal === "vendor" ? VENDOR_SCHEDULE_OPTIONS : SCHEDULE_OPTIONS;
  const manualLabel = portal === "vendor" ? "Only when I withdraw" : "Manual";
  return (
    <PortalSettingsSection title="Schedule">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Automatic payout">
          <FieldSingleSelect
            label="Automatic payout"
            hideLabel
            value={schedule.interval}
            options={options}
            onChange={(next) => onChange(next as PortalPayoutScheduleInterval)}
            dataAttr="payouts-schedule-select"
          />
        </PortalSettingsRow>
        <PortalSettingsRow label="Next payout">
          <span className="text-sm text-foreground">
            {schedule.interval === "manual"
              ? manualLabel
              : nextPayout
                ? `${nextPayout} · ${formatMoney(availableCents, currency)}`
                : "—"}
          </span>
        </PortalSettingsRow>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

function payoutMethodLabel(method: "standard" | "instant" | null): string {
  if (method === null) return "Source movement";
  return method === "instant" ? "Instant" : "Standard";
}

function PayoutHistoryRow({
  row,
  currency,
  portal,
  onRetry,
  retryDisabled = false,
}: {
  row: PortalPayoutHistoryRow;
  currency: string;
  portal: PortalPayoutsPortalKind;
  onRetry: (row: PortalPayoutHistoryRow) => void;
  retryDisabled?: boolean;
}) {
  const isReturned = row.status === "returned" || row.status === "failed";
  const isSource = row.kind === "source_movement";
  const TileIcon = row.method === "instant" ? Zap : ArrowUp;
  const sentDate = formatDate(row.createdAt);
  const arrivedDate = row.status === "paid" ? formatDate(row.arrivalDate) : null;
  const arrivesDate = row.status === "pending" || row.status === "in_transit" ? formatDate(row.arrivalDate) : null;
  const returnedDate = formatDate(row.arrivalDate) ?? sentDate;
  const canRetry = !retryDisabled && !isSource && row.status === "failed";
  const rowLabel = isSource ? `${row.serviceLabel ?? "Held on PropLane"} · ${formatMoney(row.amountCents, currency)}`
    : `${payoutMethodLabel(row.method)} payout of ${formatMoney(row.amountCents, currency)}`;

  return (
    <PortalPropertyRecordRow
      title={formatMoney(row.amountCents, currency)}
      address={isSource ? row.serviceLabel ?? "Held on PropLane"
        : `${payoutMethodLabel(row.method)}${row.destinationLast4 ? ` · Bank ····${row.destinationLast4}` : ""}`}
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
          {sentDate ? <PortalRowFact icon={Calendar}>{isSource ? "Recorded" : "Sent"} {sentDate}</PortalRowFact> : null}
          {arrivedDate ? <PortalRowFact icon={Landmark}>Arrived {arrivedDate}</PortalRowFact> : null}
          {arrivesDate ? <PortalRowFact icon={Landmark}>Arrives {arrivesDate}</PortalRowFact> : null}
          {row.method === "instant" ? <PortalRowFact icon={Zap}>Fee {formatMoney(row.feeCents, currency)}</PortalRowFact> : null}
          {isReturned ? (
            <PortalRowFact icon={AlertTriangle}>
              Returned by the bank {returnedDate ?? ""}
            </PortalRowFact>
          ) : null}
          {portal === "vendor" && !isSource && row.serviceLabel ? <PortalRowFact icon={Wrench}>{row.serviceLabel}</PortalRowFact> : null}
        </>
      }
      trailing={
        canRetry ? (
          <PayoutRowMenu rowId={row.id} label={rowLabel}>
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

/** Exported so `portal-payouts-settings-page.tsx`'s History section mounts the identical rows. */
export function HistorySection({
  rows,
  currency,
  search,
  onClearSearch,
  portal,
  onRetry,
  retryDisabled = false,
}: {
  rows: PortalPayoutHistoryRow[];
  currency: string;
  search: string;
  onClearSearch: () => void;
  portal: PortalPayoutsPortalKind;
  onRetry: (row: PortalPayoutHistoryRow) => void;
  retryDisabled?: boolean;
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
          <PayoutHistoryRow key={row.id} row={row} currency={currency} portal={portal} onRetry={onRetry} retryDisabled={retryDisabled} />
        ))}
      </PortalRecordListSurface>
    </div>
  );
}
