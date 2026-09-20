"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import {
  BUSINESS_MAX_PROPERTIES,
  PRO_MAX_PROPERTIES,
  maxAccountLinksForTier,
  type ManagerSkuTier,
} from "@/lib/manager-access";
import { includedAllowanceCents } from "@/lib/comms-billing/allowances";
import { WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";

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

/** "2 listings · 1 workspace · 1 work number · $10 credit/mo · 2 co-managers" —
 * every number here is read live from the same sources the product enforces,
 * never hardcoded, so a change to an entitlement (e.g. Business workspaces)
 * updates this copy for free. */
function entitlementLine(tier: AdjustablePaidTier): string {
  const listings = tier === "pro" ? PRO_MAX_PROPERTIES : BUSINESS_MAX_PROPERTIES;
  const workspaces = WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces;
  const workNumber = tier === "pro" ? "1 work number" : "1 work number per workspace";
  const credit = wholeDollars(includedAllowanceCents(tier));
  const coManagers = maxAccountLinksForTier(tier) ?? 0;
  return `${listings} listings · ${workspaces} workspace${workspaces === 1 ? "" : "s"} · ${workNumber} · ${credit} credit/mo · ${coManagers} co-managers`;
}

function priceLine(monthlyUsd: number): string {
  const annualUsd = Math.round(monthlyUsd * 12 * 0.8);
  return `$${monthlyUsd}/mo · $${annualUsd.toLocaleString()}/yr`;
}

const TIER_MONTHLY_USD: Record<AdjustablePaidTier, number> = { pro: 20, business: 200 };

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
}: {
  open: boolean;
  onClose: () => void;
  currentTier: ManagerSkuTier;
  currentBilling: BillingInterval;
  renewalLabel: string | null;
  busy: boolean;
  onConfirm: (target: AdjustablePaidTier, billing: BillingInterval) => void;
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
                    <span className="rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Current
                    </span>
                  ) : null}
                </div>
                <p className="text-sm tabular-nums text-muted">{priceLine(TIER_MONTHLY_USD[tier])}</p>
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

        <div className="flex flex-wrap justify-start gap-2">
          <Button type="button" variant="outline" className="rounded-full" disabled={busy} onClick={close}>
            Cancel
          </Button>
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
