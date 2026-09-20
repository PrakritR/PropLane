"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { cn } from "@/lib/utils";

export type PortalPayoutSetupStatus = {
  identity: "done" | "needed" | "pending";
  bank: "done" | "needed";
  ready: boolean;
};

function StepBadge({ index, done }: { index: number; done: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold",
        done ? "bg-primary text-white" : "bg-accent text-muted",
      )}
    >
      {done ? <Check className="size-3.5" strokeWidth={3} /> : index}
    </span>
  );
}

/**
 * Set up payouts — identity, bank, then ready. Both steps open the SAME
 * Stripe embedded onboarding flow (Stripe asks for whatever it still needs);
 * PropLane draws only the steps and their state, never the identity or bank
 * fields themselves (PLAN-0920-0853).
 *
 * `needsRelink` is the one case the saved Stripe account can no longer be
 * reached: the card offers Reconnect, which POSTs `/onboard` with
 * `{ relink: true }` — the only path that replaces a saved account id — and
 * then opens onboarding on the fresh account.
 */
export function PortalPayoutSetupCard({
  connectBase,
  setup,
  needsRelink = false,
  onReady,
}: {
  /** `/api/stripe/connect` for a manager, `/api/vendor/stripe-connect` for a vendor. */
  connectBase: string;
  setup: PortalPayoutSetupStatus;
  needsRelink?: boolean;
  /** Re-fetches the balance/setup status after the embedded flow reports it exited. */
  onReady: () => void;
}) {
  const appUi = useOptionalAppUi();
  const [open, setOpen] = useState(false);
  const identityDone = setup.identity === "done";
  const bankDone = setup.bank === "done";

  const closeAndRefresh = () => {
    setOpen(false);
    onReady();
  };

  const reconnect = async () => {
    try {
      const res = await fetch(`${connectBase}/onboard`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relink: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; needsRelink?: boolean; error?: string };
      if (res.ok) {
        setOpen(true);
        return;
      }
      if (body.code === "CONNECT_ACCOUNT_HEALTHY") {
        onReady();
        return;
      }
      appUi?.showToast(body.error ?? "Could not reconnect Stripe.");
    } catch {
      appUi?.showToast("Could not reconnect Stripe.");
    }
  };

  return (
    <PortalSettingsSection title="Set up payouts">
      <PortalSettingsGroup>
        {needsRelink ? (
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
            <span className="truncate text-sm font-medium text-foreground">Stripe account</span>
            <Button type="button" variant="outline" onClick={reconnect} data-attr="payouts-setup-reconnect">
              Reconnect
            </Button>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <StepBadge index={1} done={identityDone} />
            <span className="truncate text-sm font-medium text-foreground">Verify identity</span>
          </div>
          {identityDone ? (
            <span className="shrink-0 text-sm font-medium text-muted">Done</span>
          ) : setup.identity === "pending" ? (
            <span className="shrink-0 text-sm font-medium text-[var(--status-pending-fg)]">Needs attention</span>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(true)}
              data-attr="payouts-setup-verify"
            >
              Verify
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <StepBadge index={2} done={bankDone} />
            <span className="truncate text-sm font-medium text-foreground">Link bank</span>
          </div>
          {bankDone ? (
            <span className="shrink-0 text-sm font-medium text-muted">Done</span>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(true)}
              data-attr="payouts-setup-link-bank"
            >
              Link bank
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <StepBadge index={3} done={setup.ready} />
          <span className={cn("text-sm font-medium", setup.ready ? "text-foreground" : "text-muted")}>
            Ready to pay out
          </span>
        </div>
      </PortalSettingsGroup>
      <Modal open={open} title="Link bank" onClose={closeAndRefresh} panelClassName="max-w-lg" scrollableContent={false}>
        <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={closeAndRefresh} />
      </Modal>
    </PortalSettingsSection>
  );
}
