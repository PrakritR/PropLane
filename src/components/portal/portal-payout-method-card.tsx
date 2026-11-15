"use client";

import { useState } from "react";
import { Landmark } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import type { PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";
import { formatDate } from "@/components/portal/portal-payouts-panel";

/** The two automatic schedules an owner picks between. Weekly is Monday; Manual stays withdraw-only and has no row here. */
export const PAYOUT_METHOD_SCHEDULE_OPTIONS = [
  { value: "weekly", label: "Weekly (Mondays)" },
  { value: "daily", label: "Daily" },
] as const;

export type PayoutMethodSchedule = "daily" | "weekly";

/** "Bank •••• 1234": only the last four Stripe returns, never anything longer. */
export function payoutMethodBankLabel(bank: { bankName?: string | null; last4?: string | null } | null | undefined): string | null {
  const last4 = String(bank?.last4 ?? "").replace(/\D/g, "").slice(-4);
  if (!last4) return null;
  const name = String(bank?.bankName ?? "").trim();
  return `${name || "Bank"} •••• ${last4}`;
}

/**
 * Payout method, in the app: not set up shows Stripe's embedded onboarding right here (any US bank, instant bank login
 * or routing entry, identity), set up shows the bank, the automatic schedule and Stripe's read-only balance and payout
 * history. When Stripe's components cannot load (no publishable key, a refused session) the card steps aside and the
 * page's own "Add a bank account" flow is the fallback.
 */
export function PortalPayoutMethodCard({
  connectBase,
  setup,
  schedule,
  bank,
  onSchedule,
  onChanged,
  onFallback,
}: {
  connectBase: string;
  setup: PortalPayoutBalance["setup"];
  schedule: PortalPayoutBalance["schedule"];
  bank: { bankName?: string | null; last4?: string | null } | null;
  onSchedule: (interval: PayoutMethodSchedule) => void | Promise<void>;
  /** Re-reads the balance and banks after the embedded flow reports it exited. */
  onChanged: () => void;
  /** Opens the in-app add-bank flow when the embedded components are unavailable. */
  onFallback: () => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const bankLabel = payoutMethodBankLabel(bank);
  const next = formatDate(schedule.nextPayoutAt);
  const automatic = schedule.interval === "daily" || schedule.interval === "weekly";

  if (!setup.ready) {
    return (
      <PortalSettingsSection
        title="Payout method"
        action={unavailable ? <PortalIconAction icon={Landmark} label="Set up payouts" onClick={onFallback} data-attr="payout-method-fallback" /> : undefined}
      >
        {unavailable ? null : (
          <div data-attr="payout-method-onboarding">
            <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={onChanged} onUnavailable={() => setUnavailable(true)} />
          </div>
        )}
      </PortalSettingsSection>
    );
  }

  return (
    <>
      <PortalSettingsSection title="Payout method">
        <div data-attr="payout-method-banner">
          <StripeConnectEmbedded connectBase={connectBase} component="notification_banner" onUnavailable={() => undefined} />
        </div>
        <PortalSettingsGroup>
          <PortalSettingsRow label="Bank account">
            <span className="text-sm text-foreground" data-attr="payout-method-bank">{bankLabel ?? "No bank account yet"}</span>
          </PortalSettingsRow>
          {automatic ? (
            <>
              <PortalSettingsRow label="Payout schedule">
                <FieldSingleSelect
                  label="Payout schedule"
                  hideLabel
                  variant="cell"
                  value={schedule.interval}
                  options={[...PAYOUT_METHOD_SCHEDULE_OPTIONS]}
                  onChange={(value) => void onSchedule(value as PayoutMethodSchedule)}
                  dataAttr="payout-method-schedule"
                />
              </PortalSettingsRow>
              {next ? (
                <PortalSettingsRow label="Next payout"><span className="text-sm text-foreground">{next}</span></PortalSettingsRow>
              ) : null}
            </>
          ) : null}
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <PortalSettingsSection title="Stripe balance">
        <div data-attr="payout-method-payouts">
          <StripeConnectEmbedded connectBase={connectBase} component="payouts" onUnavailable={() => undefined} />
        </div>
      </PortalSettingsSection>
    </>
  );
}
