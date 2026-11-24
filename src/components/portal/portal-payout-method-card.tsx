"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import type { PortalPayoutBalance } from "@/components/portal/portal-payouts-panel";
import { formatDate } from "@/components/portal/portal-payouts-panel";
import type { BankChangeResponse } from "@/lib/stripe-connect-bank-change";

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

/** What the person is told for a failed bank change: the server's own sentence, never a blank. */
export function bankChangeFailureMessage(status: number, body: { error?: unknown } | null): string {
  const error = typeof body?.error === "string" ? body.error.trim() : "";
  return error || (status === 401 ? "Sign in again to change the bank." : "Could not open the bank change. Try again shortly.");
}

/**
 * Asks the server how to change the bank: `in_app` (PropLane's own sheet) or `redirect` (Stripe's hosted page for a
 * legacy Express account, which returns to this card with `?bank=returned`). Throws a real message on failure.
 */
export async function requestBankChange(connectBase: string): Promise<BankChangeResponse> {
  const res = await fetch(`${connectBase}/change-bank`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = (await res.json().catch(() => null)) as (Partial<BankChangeResponse> & { error?: unknown }) | null;
  if (!res.ok) throw new Error(bankChangeFailureMessage(res.status, body));
  if (body?.mode === "redirect" && typeof body.url === "string" && body.url.startsWith("https://")) return { mode: "redirect", url: body.url, via: body.via ?? "login_link" } as BankChangeResponse;
  if (body?.mode === "in_app") return { mode: "in_app" };
  throw new Error("Could not open the bank change. Try again shortly.");
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
  const { showToast } = useAppUi();
  const [unavailable, setUnavailable] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const bankLabel = payoutMethodBankLabel(bank);
  const next = formatDate(schedule.nextPayoutAt);
  const automatic = schedule.interval === "daily" || schedule.interval === "weekly";

  // Back from Stripe's hosted page: re-read the account so the bank shown is the one Stripe now holds.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("bank");
    if (outcome !== "returned" && outcome !== "refresh") return;
    url.searchParams.delete("bank");
    window.history.replaceState(window.history.state, "", url.toString());
    if (outcome === "refresh") setProblem("That Stripe link expired. Choose Change bank to open a new one.");
    onChanged();
  }, [onChanged]);

  const changeBank = useCallback(async () => {
    if (changing) return;
    setChanging(true);
    setProblem(null);
    try {
      const next = await requestBankChange(connectBase);
      if (next.mode === "redirect") {
        window.location.assign(next.url);
        return;
      }
      onFallback();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not open the bank change.";
      setProblem(message);
      showToast(message);
    } finally {
      setChanging(false);
    }
  }, [changing, connectBase, onFallback, showToast]);

  const problemBanner = problem ? (
    <p role="alert" className="rounded-xl border px-4 py-3 text-sm portal-banner-danger" data-attr="payout-method-error">{problem}</p>
  ) : null;

  if (!setup.ready) {
    return (
      <PortalSettingsSection
        title="Payout method"
        action={unavailable ? <PortalIconAction icon={Landmark} label="Set up payouts" disabled={changing} onClick={() => changeBank()} data-attr="payout-method-fallback" /> : undefined}
      >
        {problemBanner}
        {unavailable ? null : (
          <div data-attr="payout-method-onboarding">
            <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={onChanged} onUnavailable={(message) => { setUnavailable(true); setProblem(message); }} />
          </div>
        )}
      </PortalSettingsSection>
    );
  }

  return (
    <>
      <PortalSettingsSection
        title="Payout method"
        action={<PortalIconAction icon={Landmark} label="Change bank" disabled={changing} onClick={() => changeBank()} data-attr="payout-method-change-bank" />}
      >
        {problemBanner}
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
          ) : (
            <PortalSettingsRow label="Payout schedule"><span className="text-sm text-foreground" data-attr="payout-method-schedule-manual">{schedule.interval === "manual" ? "Manual (withdraw only)" : "Monthly"}</span></PortalSettingsRow>
          )}
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
