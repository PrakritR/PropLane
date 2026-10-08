"use client";

/**
 * PropLane Number rows for the vendor's Settings > Work number & email (and the last step of onboarding, which
 * embeds the same component). Everything here is inert while `NUMBER_SUBSCRIPTION_ENABLED` is off: the status
 * endpoint answers `enabled: false`, `useVendorNumberBilling` yields null, and the free claim shows as before.
 *
 * Labels and controls only (AGENTS.md § No subtext). Subscribe, Manage and Buy credit go through the number
 * routes, which pin the owner to the session; the page only ever sends the amount and a purchase id.
 */
import { Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COMMS_CREDIT_MAX_CENTS, COMMS_CREDIT_MIN_CENTS, isValidCommsCreditAmountCents } from "@/lib/comms-billing/credit-packs";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import { formatPacificDate } from "@/lib/pacific-time";

export type VendorNumberBilling = {
  priceCents: number;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  credit: { includedCents: number; purchasedCents: number; totalCents: number } | null;
};

/** `active` or `past_due`: the states that keep the number (numberServiceEntitled on the server). */
export function vendorNumberEntitledStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "past_due";
}

/**
 * The vendor's PropLane Number status. `billing` stays null while loading, in /demo (which never touches the
 * network), and whenever the subscription is off or unreadable: exactly today's free-number UI (the server still
 * refuses an unsubscribed claim).
 */
export function useVendorNumberBilling(demo: boolean) {
  const [billing, setBilling] = useState<VendorNumberBilling | null>(null);
  const [loaded, setLoaded] = useState(demo);
  const reload = useCallback(async () => {
    if (demo) return;
    try {
      const res = await fetch("/api/number-subscription?role=vendor", { credentials: "include", cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        enabled?: boolean;
        priceCents?: number;
        subscription?: VendorNumberBilling["subscription"];
        credit?: VendorNumberBilling["credit"];
      };
      setBilling(res.ok && body.ok && body.enabled === true ? { priceCents: body.priceCents ?? 500, subscription: body.subscription ?? null, credit: body.credit ?? null } : null);
    } catch {
      setBilling(null);
    } finally {
      setLoaded(true);
    }
  }, [demo]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { billing, loaded, reload };
}

function returnPath(): string {
  return typeof window === "undefined" ? "/vendor/settings" : `${window.location.pathname}${window.location.search}`;
}

async function postForUrl(path: string, payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "vendor", returnPath: returnPath(), ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? "This is temporarily unavailable. Try again.");
  return body.url;
}

function go(url: string, demo: boolean) {
  if (!demo) window.location.assign(url);
}

function dollars(cents: number): string {
  return formatUsdFromCents(cents);
}

/** The subscription price: "$5" (no cents when it is a whole dollar). */
function priceLabel(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : dollars(cents);
}

/** Not subscribed: "Your own work number · $5 / month · Subscribe". */
export function VendorNumberSubscribeRow({ billing, demo }: { billing: VendorNumberBilling; demo: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const subscribe = async () => {
    setError(null);
    try {
      go(await postForUrl("/api/number-subscription/checkout", {}), demo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "This is temporarily unavailable. Try again.");
    }
  };
  return (
    <PortalSettingsRow label="Your own work number">
      <span className="inline-flex flex-col items-end gap-1">
        <span className="inline-flex items-center gap-3">
          <span className="text-sm font-medium text-foreground" data-attr="vendor-number-price">
            {priceLabel(billing.priceCents)} / month
          </span>
          <Button variant="primary" onClick={subscribe} data-attr="vendor-number-subscribe">
            Subscribe
          </Button>
        </span>
        {error ? (
          <span role="alert" className="text-[12.5px] text-danger" data-attr="vendor-number-subscribe-error">
            {error}
          </span>
        ) : null}
      </span>
    </PortalSettingsRow>
  );
}

function planLine(billing: VendorNumberBilling): string {
  const sub = billing.subscription;
  const price = `${priceLabel(billing.priceCents)}/month`;
  if (!sub) return `PropLane Number · ${price}`;
  if (sub.status === "past_due") return `PropLane Number · ${price} · payment failed`;
  if (!sub.currentPeriodEnd) return `PropLane Number · ${price}`;
  const date = formatPacificDate(sub.currentPeriodEnd, { month: "short", day: "numeric" });
  return `PropLane Number · ${price} · ${sub.cancelAtPeriodEnd ? "ends" : "renews"} ${date}`;
}

/** Subscribed: the plan line with Manage, and the credit row with Buy credit (or "Out of credit"). */
export function VendorNumberSubscribedRows({ billing, demo, onChanged }: { billing: VendorNumberBilling; demo: boolean; onChanged?: () => void }) {
  const [buying, setBuying] = useState(false);
  const [amount, setAmount] = useState("20");
  const [purchaseId, setPurchaseId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const credit = billing.credit;
  const outOfCredit = credit !== null && credit.totalCents <= 0;

  const manage = async () => {
    setError(null);
    try {
      go(await postForUrl("/api/number-subscription/portal", {}), demo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "This is temporarily unavailable. Try again.");
    }
  };

  const whole = Number(amount);
  const creditCents = Number.isFinite(whole) ? Math.round(whole * 100) : NaN;
  const amountOk = /^\d+$/.test(amount.trim()) && isValidCommsCreditAmountCents(creditCents);
  const pay = async () => {
    setError(null);
    if (!amountOk) {
      setError(`Enter a whole-dollar amount from ${dollars(COMMS_CREDIT_MIN_CENTS)} to ${dollars(COMMS_CREDIT_MAX_CENTS)}.`);
      return;
    }
    // One id per purchase attempt: a double tap or a retry can never create two purchases.
    const id = purchaseId ?? crypto.randomUUID();
    setPurchaseId(id);
    try {
      go(await postForUrl("/api/number-subscription/credit-checkout", { creditCents, purchaseId: id }), demo);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "This is temporarily unavailable. Try again.");
    }
  };

  return (
    <>
      <PortalSettingsRow label="PropLane Number">
        <span className="inline-flex items-center gap-1">
          <span className="text-sm text-muted" data-attr="vendor-number-plan">
            {planLine(billing)}
          </span>
          <PortalIconAction icon={Settings} label="Manage subscription" onClick={manage} data-attr="vendor-number-manage" />
        </span>
      </PortalSettingsRow>
      {credit ? (
        <PortalSettingsRow label={outOfCredit ? "Out of credit" : "Credit"}>
          <span className="inline-flex items-center gap-3">
            <span className="text-sm text-muted" data-attr="vendor-number-credit">
              {outOfCredit
                ? "AI replies and texts are paused until the 1st or until you buy credit"
                : `${dollars(credit.includedCents)} left this month · ${dollars(credit.purchasedCents)} bought`}
            </span>
            <Button variant={outOfCredit ? "primary" : "secondary"} onClick={() => setBuying((open) => !open)} data-attr="vendor-number-buy-credit">
              Buy credit
            </Button>
          </span>
        </PortalSettingsRow>
      ) : null}
      {buying ? (
        <div className="border-b border-border" data-attr="vendor-number-buy-credit-form">
          <PortalSettingsRow label="Amount" className="border-b-0">
            <span className="inline-flex items-center justify-end gap-2">
              <span className="text-sm text-muted">$</span>
              <Input
                aria-label="Credit amount in dollars"
                inputMode="numeric"
                className="w-24 text-right"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/\D/g, "").slice(0, 3))}
                data-attr="vendor-number-credit-amount"
              />
              <Button variant="ghost" onClick={() => setBuying(false)} data-attr="vendor-number-credit-cancel">
                Cancel
              </Button>
              <Button variant="primary" disabled={!amountOk} onClick={pay} data-attr="vendor-number-credit-pay">
                {amountOk ? `Pay $${whole}` : "Pay"}
              </Button>
            </span>
          </PortalSettingsRow>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 pb-3 text-[12.5px] text-danger" data-attr="vendor-number-billing-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
