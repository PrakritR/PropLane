"use client";

/**
 * Resident Settings > PropLane agent: the resident's own number and the AI behind it
 * (docs/ai-assistant.md § Resident personal agent). Labels only: a row carries a label and its
 * control. Not subscribed -> one Subscribe row; subscribed -> number (copy), plan (Manage), credit
 * (Buy credit). Hidden entirely while NUMBER_SUBSCRIPTION_ENABLED is off.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

export type ResidentAgentSnapshot = {
  enabled: boolean;
  /** False when a NEW subscriber's number cannot be provisioned yet (runtime off or provider unset). */
  available?: boolean;
  priceCents?: number;
  includedMonthlyCents?: number;
  subscription?: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  credit?: { totalCents: number; includedCents: number; purchasedCents: number };
  number?: { state: string; phoneNumber: string | null; sendReady: boolean };
  phoneVerified?: boolean;
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The snapshot, or null while loading / unavailable. `enabled: false` means the feature is hidden. */
export function useResidentAgentSnapshot(): { snapshot: ResidentAgentSnapshot | null; reload: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<ResidentAgentSnapshot | null>(null);
  const reload = useCallback(async () => {
    if (isDemoModeActive()) return;
    try {
      const res = await fetch("/api/number-subscription/resident-number", { cache: "no-store" });
      if (!res.ok) return setSnapshot(null);
      setSnapshot((await res.json()) as ResidentAgentSnapshot);
    } catch {
      setSnapshot(null);
    }
  }, []);
  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/number-subscription/resident-number", { cache: "no-store" });
        if (cancelled) return;
        setSnapshot(res.ok ? ((await res.json()) as ResidentAgentSnapshot) : null);
      } catch {
        if (!cancelled) setSnapshot(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { snapshot, reload };
}

type ProvisionOutcome = { status: string; reason?: string };

/** What the resident reads when "Get my number" did not end with a number. Never a silent no-op. */
export function residentNumberProvisionMessage(provision: ProvisionOutcome | undefined): string | null {
  if (!provision || provision.status === "ready" || provision.status === "already") return null;
  if (provision.status === "pending") return "Your number is being set up. Check back in a minute.";
  if (provision.status === "skipped") {
    if (provision.reason === "phone_unverified") return "Verify your phone to get your number.";
    if (provision.reason === "not_entitled") return "Subscribe to get your number.";
    if (provision.reason === "no_candidate") return "No number is available near your area code right now. Try again later.";
    return "Numbers are not available yet. Try again later.";
  }
  return "Could not get your number. Try again.";
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; url?: string; error?: string; provision?: ProvisionOutcome }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; url?: string; error?: string; provision?: ProvisionOutcome };
  } catch {
    return { ok: false, error: "Could not reach PropLane. Try again." };
  }
}

export function ResidentAgentSettings({ snapshot, reload }: { snapshot: ResidentAgentSnapshot; reload: () => Promise<void> }) {
  const toast = useOptionalAppUi();
  const pathname = usePathname();
  const returnPath = `${pathname}?tab=agent`;
  const [buying, setBuying] = useState(false);
  const [amount, setAmount] = useState("10");

  const go = async (url: string, body: Record<string, unknown>) => {
    const result = await postJson(url, { role: "resident", returnPath, ...body });
    if (result.ok && result.url) {
      window.location.assign(result.url);
      return;
    }
    toast?.showToast(result.error ?? "Something went wrong. Try again.");
  };

  const status = snapshot.subscription?.status;
  const entitled = status === "active" || status === "past_due";
  const number = snapshot.number;
  const priceLabel = `$${((snapshot.priceCents ?? 500) / 100).toFixed(0)} / month`;

  // Back from Stripe Checkout (`?number=success`): the webhook that records the subscription and buys the number
  // can land a few seconds after the redirect, so poll quietly instead of offering a second Subscribe.
  const [activating, setActivating] = useState(false);
  useEffect(() => {
    if (isDemoModeActive()) return;
    if (new URLSearchParams(window.location.search).get("number") === "success") setActivating(true);
  }, []);
  const numberReadyNow = number?.state === "ready" && Boolean(number.phoneNumber);
  useEffect(() => {
    if (!activating) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      void reload();
      if (ticks >= 20) setActivating(false);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activating, reload]);
  useEffect(() => {
    if (!activating || !entitled) return;
    if (numberReadyNow || snapshot.phoneVerified === false) {
      setActivating(false);
      return;
    }
    const grace = window.setTimeout(() => setActivating(false), 15_000);
    return () => window.clearTimeout(grace);
  }, [activating, entitled, numberReadyNow, snapshot.phoneVerified]);

  if (!entitled) {
    return (
      <>
        <PortalSettingsSection title="PropLane agent">
          <PortalSettingsGroup>
            <PortalSettingsRow label={`Your own PropLane agent · ${priceLabel}`}>
              {activating ? (
                <span className="text-sm text-muted" role="status" data-attr="resident-agent-activating">
                  Activating…
                </span>
              ) : snapshot.available === false ? (
                <span className="text-sm text-muted" data-attr="resident-agent-unavailable">
                  Unavailable
                </span>
              ) : (
                <Button type="button" variant="primary" className="px-4 text-[13px]" data-attr="resident-agent-subscribe" onClick={() => go("/api/number-subscription/checkout", {})}>
                  Subscribe
                </Button>
              )}
            </PortalSettingsRow>
          </PortalSettingsGroup>
        </PortalSettingsSection>
      </>
    );
  }

  const cents = Math.round(Number(amount) * 100);
  const amountValid = Number.isInteger(Number(amount)) && cents >= 500 && cents <= 50000;

  return (
    <>
      <PortalSettingsSection title="PropLane agent">
        <PortalSettingsGroup>
          {number?.state === "ready" && number.phoneNumber ? (
            <PortalSettingsRow label="Number">
              <span className="inline-flex items-center gap-1">
                <b className="text-[14.5px] font-bold text-foreground" data-attr="resident-agent-number-value">
                  {formatSmsPhoneLabel(number.phoneNumber) ?? number.phoneNumber}
                </b>
                <CopyIconAction
                  label="Copy number"
                  onCopy={() => copyTextToClipboard(number.phoneNumber ?? "").then((ok) => ok && toast?.showToast("Number copied."))}
                  data-attr="resident-agent-number-copy"
                />
              </span>
            </PortalSettingsRow>
          ) : snapshot.phoneVerified === false ? (
            <PortalSettingsRow label="Number">
              <Link
                href={`${pathname}?tab=messaging`}
                className="text-sm font-semibold text-primary underline-offset-2 hover:underline"
                data-attr="resident-agent-verify-phone"
              >
                Verify your phone to get one
              </Link>
            </PortalSettingsRow>
          ) : number && (number.state === "provisioning" || number.state === "reconciling") ? (
            <PortalSettingsRow label="Number">
              <Button
                type="button"
                variant="outline"
                className="px-4 text-[13px]"
                data-attr="resident-agent-number-refresh"
                onClick={async () => {
                  await postJson("/api/number-subscription/resident-number", {});
                  await reload();
                }}
              >
                Setting up… Refresh
              </Button>
            </PortalSettingsRow>
          ) : (
            <PortalSettingsRow label="Number">
              <Button
                type="button"
                variant="primary"
                className="px-4 text-[13px]"
                data-attr="resident-agent-number-get"
                onClick={async () => {
                  const result = await postJson("/api/number-subscription/resident-number", {});
                  if (!result.ok) toast?.showToast(result.error ?? "Could not get your number. Try again.");
                  else {
                    const message = residentNumberProvisionMessage(result.provision);
                    if (message) toast?.showToast(message);
                  }
                  await reload();
                }}
              >
                Get my number
              </Button>
            </PortalSettingsRow>
          )}

          <PortalSettingsRow
            label={
              status === "past_due"
                ? `PropLane Number · ${priceLabel} · Payment failed`
                : snapshot.subscription?.cancelAtPeriodEnd && snapshot.subscription.currentPeriodEnd
                  ? `PropLane Number · ${priceLabel} · Ends ${new Date(snapshot.subscription.currentPeriodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                  : `PropLane Number · ${priceLabel}`
            }
          >
            <PortalIconAction
              icon={Settings}
              label="Manage plan"
              data-attr="resident-agent-manage"
              onClick={() => go("/api/number-subscription/portal", {})}
            />
          </PortalSettingsRow>

          <PortalSettingsRow label={`Credit · ${dollars(snapshot.credit?.totalCents ?? 0)}`}>
            {buying ? (
              <span className="inline-flex items-center gap-2">
                <Input
                  aria-label="Credit amount in dollars"
                  inputMode="numeric"
                  className="h-9 w-20 text-sm"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                />
                <Button
                  type="button"
                  variant="primary"
                  className="px-4 text-[13px]"
                  disabled={!amountValid}
                  data-attr="resident-agent-credit-pay"
                  onClick={() => go("/api/number-subscription/credit-checkout", { creditCents: cents, purchaseId: crypto.randomUUID() })}
                >
                  {amountValid ? `Pay $${amount}` : "$5 to $500"}
                </Button>
              </span>
            ) : (
              <Button type="button" variant="primary" className="px-4 text-[13px]" data-attr="resident-agent-buy-credit" onClick={() => setBuying(true)}>
                Buy credit
              </Button>
            )}
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </>
  );
}
