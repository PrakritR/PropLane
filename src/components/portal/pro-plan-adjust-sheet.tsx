"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import {
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { includedAllowanceCents } from "@/lib/comms-billing/allowances";
import { WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";
import { RATE_CARD, priceForResidents, formatRateCardUsd, includedResidentsForTier } from "@/lib/billing/rate-card";

export type AdjustablePaidTier = "pro" | "business";
export type BillingInterval = "monthly" | "annual";

function tierLabel(t: ManagerSkuTier): string {
  if (t === "free") return "Free";
  if (t === "pro") return "Pro";
  return "Business";
}

function tierRank(t: ManagerSkuTier): number {
  if (t === "free") return 0;
  if (t === "pro") return 1;
  return 2;
}

function wholeDollars(cents: number | null): string {
  if (!cents) return "$0";
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "100 residents incl. · $3/resident after · 1 workspace · 1 work number ·
 * $25 credit/mo" — every number here is read live from the same sources the
 * product enforces. */
function entitlementLine(tier: AdjustablePaidTier): string {
  const card = RATE_CARD[tier];
  const workspaces = WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces;
  const residents = includedResidentsForTier(tier);
  const workNumber = "1 work number per workspace";
  const credit = wholeDollars(includedAllowanceCents(tier));
  const residentLine = `${residents} residents incl. · ${formatRateCardUsd(card.perExtraDoorMonthlyCents ?? 0)}/resident after`;
  return `${residentLine} · ${workspaces} workspace${workspaces === 1 ? "" : "s"} · ${workNumber} · ${credit} credit/mo`;
}

/** The tier's own floor, read from the rate card — never a hand-typed
 * dollar figure that can drift from what `priceForResidents` actually charges. */
function tierFloorPriceLine(tier: AdjustablePaidTier): string {
  const card = RATE_CARD[tier];
  return `${formatRateCardUsd(card.floorMonthlyCents)}/mo · ${formatRateCardUsd(card.floorAnnualCents)}/yr`;
}

/** What THIS account would actually pay on `tier` at `billing`, priced
 * against its real live resident count — so switching plans is never a guess.
 * `null` while the resident count is still loading. */
function tierAccountPriceLine(
  tier: AdjustablePaidTier,
  billing: BillingInterval,
  residentCount: number | null,
): string | null {
  if (residentCount == null) return null;
  const cents = priceForResidents(tier, residentCount, billing);
  const suffix = billing === "annual" ? "/yr" : "/mo";
  return `${formatRateCardUsd(cents)}${suffix} for your ${residentCount} resident${residentCount === 1 ? "" : "s"}`;
}

/**
 * The fact line under the selected row: what actually happens if Confirm is
 * pressed, stated plainly. Same-tier billing switches and tier changes both
 * flow through `POST /api/stripe/subscription/update-tier`, which already
 * implements exactly this: same-tier Monthly→Annual applies today with
 * proration; same-tier Annual→Monthly and any tier downgrade (e.g.
 * Business→Pro) schedule at the current period's end via its
 * `scheduledDowngrade` metadata plumbing. This sheet never re-implements that
 * decision — it only describes it ahead of Confirm.
 */
export function planAdjustTransitionFact(
  currentTier: ManagerSkuTier,
  currentBilling: BillingInterval,
  targetTier: AdjustablePaidTier,
  targetBilling: BillingInterval,
  renewalLabel: string | null,
): string | null {
  if (targetTier === currentTier) {
    if (targetBilling === currentBilling) return null;
    if (currentBilling === "monthly" && targetBilling === "annual") return "Annual applies today · prorated";
    return renewalLabel ? `Monthly from ${renewalLabel}` : "Monthly at your next renewal";
  }
  if (tierRank(targetTier) > tierRank(currentTier)) return `${tierLabel(targetTier)} today · prorated`;
  return renewalLabel ? `${tierLabel(targetTier)} from ${renewalLabel}` : `${tierLabel(targetTier)} at your next renewal`;
}

export function PlanAdjustSheet({
  open,
  onClose,
  currentTier,
  currentBilling,
  renewalLabel,
  busy,
  onConfirm,
  residentCount = null,
}: {
  open: boolean;
  onClose: () => void;
  currentTier: ManagerSkuTier;
  currentBilling: BillingInterval;
  renewalLabel: string | null;
  busy: boolean;
  onConfirm: (target: AdjustablePaidTier, billing: BillingInterval) => void;
  /** This account's live resident count, so each card can price what switching
   * to it would actually cost. `null` while still loading. */
  residentCount?: number | null;
}) {
  const [billing, setBilling] = useState<BillingInterval>(currentBilling);
  const [selected, setSelected] = useState<AdjustablePaidTier | null>(
    currentTier === "free" ? null : (currentTier as AdjustablePaidTier),
  );

  const close = () => {
    if (busy) return;
    onClose();
  };

  const fact =
    selected != null ? planAdjustTransitionFact(currentTier, currentBilling, selected, billing, renewalLabel) : null;

  return (
    <Modal open={open} title="Adjust plan" onClose={close}>
      <div className="space-y-4">
        <div className="surface-panel inline-flex items-center gap-1 rounded-full border border-border p-1">
          <button
            type="button"
            onClick={() => setBilling("monthly")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              billing === "monthly" ? "bg-primary text-white" : "text-muted hover:text-foreground"
            }`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBilling("annual")}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              billing === "annual" ? "bg-primary text-white" : "text-muted hover:text-foreground"
            }`}
          >
            Annual
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                billing === "annual" ? "bg-card/20 text-white" : "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
              }`}
            >
              −20%
            </span>
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border">
          {(["pro", "business"] as const).map((tier) => {
            const isCurrent = tier === currentTier;
            const isSelected = selected === tier;
            return (
              <button
                key={tier}
                type="button"
                onClick={() => setSelected(tier)}
                disabled={busy}
                data-attr={`plan-adjust-row-${tier}`}
                className={`flex w-full flex-col items-start gap-1 border-b border-border px-4 py-3.5 text-left last:border-0 transition ${
                  isSelected ? "bg-primary/5" : "hover:bg-accent/20"
                }`}
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-sm font-bold text-foreground">{tierLabel(tier)}</span>
                  {isCurrent ? (
                    <span className="text-sm text-muted">Current</span>
                  ) : null}
                </div>
                <p className="text-sm tabular-nums text-muted">{tierFloorPriceLine(tier)}</p>
                {tierAccountPriceLine(tier, billing, residentCount) ? (
                  <p
                    className="text-sm font-semibold tabular-nums text-foreground"
                    data-attr={`plan-adjust-account-price-${tier}`}
                  >
                    {tierAccountPriceLine(tier, billing, residentCount)}
                  </p>
                ) : null}
                <p className="text-xs text-muted">{entitlementLine(tier)}</p>
              </button>
            );
          })}
        </div>

        {fact ? (
          <p className="text-sm text-muted" data-attr="plan-adjust-fact">
            {fact}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={busy || !selected || (selected === currentTier && billing === currentBilling)}
            onClick={() => selected && onConfirm(selected, billing)}
            data-attr="plan-adjust-confirm"
          >
            {busy ? "Processing…" : "Confirm"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
