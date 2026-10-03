"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { includedAllowanceCents } from "@/lib/comms-billing/allowances";
import { WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";
import { annualDiscountPercent, RATE_CARD, priceForResidents, formatRateCardUsd, includedResidentsForTier } from "@/lib/billing/rate-card";

export type AdjustablePaidTier = "free" | "pro" | "business";
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
    currentTier,
  );

  const close = () => {
    if (busy) return;
    onClose();
  };

  const fact =
    selected != null ? planAdjustTransitionFact(currentTier, currentBilling, selected, billing, renewalLabel) : null;

  return (
    <Modal open={open} title="Change plan" onClose={close}>
      <div className="space-y-3" role="radiogroup" aria-label="Plan">
        <div className="flex rounded-lg bg-accent/40 p-1" role="group" aria-label="Billing period">
          {(["monthly", "annual"] as const).map((interval) => <button key={interval} type="button" aria-pressed={billing === interval} onClick={() => setBilling(interval)} className={`flex-1 rounded-md py-2 text-sm ${billing === interval ? "bg-card shadow-sm" : "text-muted"}`}>
            {interval === "monthly" ? "Monthly" : `Yearly · Save ${annualDiscountPercent("pro")}%`}
          </button>)}
        </div>
        {(["free", "pro", "business"] as const).map((tier) => <button key={tier} type="button" role="radio" aria-checked={selected === tier} disabled={busy} onClick={() => setSelected(tier)} data-attr={`plan-adjust-row-${tier}`} className={`flex w-full gap-3 rounded-xl border p-3.5 text-left ${selected === tier ? "border-primary bg-primary/5" : "border-border"}`}>
          <span className={`mt-1 size-5 shrink-0 rounded-full border ${selected === tier ? "border-[6px] border-primary" : "border-border"}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-2"><strong>{tierLabel(tier)}</strong>{currentTier === tier ? <span className="text-xs text-muted">✓ Current plan</span> : null}<span className="ml-auto text-sm">{formatRateCardUsd(billing === "annual" ? RATE_CARD[tier].floorAnnualCents : RATE_CARD[tier].floorMonthlyCents)} / {billing === "annual" ? "yr" : "mo"}</span></span>
            <span className="mt-2 grid gap-1 text-sm">
              <span>✓ {includedResidentsForTier(tier)} residents included{RATE_CARD[tier].perExtraDoorMonthlyCents ? ` · ${formatRateCardUsd(RATE_CARD[tier].perExtraDoorMonthlyCents!)} each after` : ""}</span>
              <span>✓ {WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces} workspace{WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces === 1 ? "" : "s"}</span>
              <span>✓ {wholeDollars(includedAllowanceCents(tier))} messaging credit / month</span>
            </span>
            {tier !== "free" && tierAccountPriceLine(tier, billing, residentCount) ? <span className="mt-2 block text-sm" data-attr={`plan-adjust-account-price-${tier}`}>{tierAccountPriceLine(tier, billing, residentCount)}</span> : null}
          </span>
        </button>)}
      </div>
      <details className="my-3"><summary className="cursor-pointer py-2 text-sm text-primary">Compare all features</summary>
        <table className="w-full text-sm"><thead><tr><th className="text-left">Included</th><th>Free</th><th>Pro</th><th>Business</th></tr></thead><tbody>
          <tr><td className="py-3">Residents</td>{(["free", "pro", "business"] as const).map(tier => <td key={tier} className="text-center">{includedResidentsForTier(tier)}</td>)}</tr>
          <tr><td className="py-3">Workspaces</td>{(["free", "pro", "business"] as const).map(tier => <td key={tier} className="text-center">{WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces}</td>)}</tr>
          <tr><td className="py-3">Messaging credit</td>{(["free", "pro", "business"] as const).map(tier => <td key={tier} className="text-center">{wholeDollars(includedAllowanceCents(tier))}</td>)}</tr>
        </tbody></table>
      </details>
      {fact ? <p className="text-sm text-muted" data-attr="plan-adjust-fact">{fact}</p> : null}
      <ModalFooter><Button disabled={busy || !selected || (selected === currentTier && (selected === "free" || billing === currentBilling))} onClick={() => selected && onConfirm(selected, billing)} data-attr="plan-adjust-confirm">{busy ? "Processing…" : selected === currentTier ? "Change billing period" : `Switch to ${selected ? tierLabel(selected) : "a plan"}`}</Button></ModalFooter>
    </Modal>
  );
}
