"use client";

/**
 * VD55/VD68 — Settings > Payouts, appended under the existing Payouts card
 * (owned by portal-payouts-settings-page.tsx, untouched): dense rows, label
 * left / control right, no subtext (AGENTS.md). Bank on file, payout
 * schedule, and History already exist on that shared page; this is only the
 * VENDOR-specific additions: instant payout eligibility, the PropLane fee
 * rate, W-9 status, and 1099 delivery. Mounted only for the vendor portal,
 * only once VENDOR_BANKING_ENABLED is on (signaled by `feeBps` being
 * present on the balance snapshot) — inert otherwise.
 */
import { useEffect, useState } from "react";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Badge } from "@/components/ui/badge";
import type { PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";

type TaxProfile = { w9_received_at: string | null } | null;

export function VendorPayoutsSettingsExtra({ balance }: { balance: PortalPayoutBalance }) {
  const [taxProfile, setTaxProfile] = useState<TaxProfile>(null);
  const [taxLoaded, setTaxLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/vendor/tax-profile", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { profile?: TaxProfile } | null) => {
        setTaxProfile(body?.profile ?? null);
        setTaxLoaded(true);
      })
      .catch(() => setTaxLoaded(true));
  }, []);

  if (typeof balance.feeBps !== "number") return null;

  const instantEligible = balance.bank?.instantEligible ?? false;

  return (
    <div className="vbank-payouts-extra" data-attr="vendor-payouts-settings-extra">
      <PortalSettingsSection title="PropLane fee & filing">
        <PortalSettingsGroup>
          <PortalSettingsRow label="PropLane fee">
            <span className="text-sm font-medium text-foreground">{(balance.feeBps / 100).toFixed(0)}% of each payment</span>
          </PortalSettingsRow>
          <PortalSettingsRow label="Instant payout eligibility">
            <span className="text-sm font-medium text-foreground">
              {balance.bank ? (instantEligible ? "Eligible" : "Not eligible") : "Add a bank first"}
            </span>
          </PortalSettingsRow>
          <PortalSettingsRow label="W-9 on file">
            {!taxLoaded ? (
              <span className="text-sm text-muted">—</span>
            ) : taxProfile?.w9_received_at ? (
              <Badge tone="confirmed">On file</Badge>
            ) : (
              <Badge tone="pending">Not submitted</Badge>
            )}
          </PortalSettingsRow>
          <PortalSettingsRow label="1099 delivery">
            <span className="text-sm font-medium text-foreground">In-app (once available)</span>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </div>
  );
}
