"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";

/**
 * Communication-header entry point to work-number setup. Three states, keyed on
 * the account's authoritative plan (`planTier`) and whether a number is already
 * assigned:
 *  - free plan → greyed, non-actionable, tooltip prompting a Pro upgrade.
 *  - paid (or unreadable) plan, no number yet → active "Set up messaging" → Settings.
 *  - number already assigned → nothing rendered (the CTA "goes away" once set up).
 *
 * `planTier === "unknown"` (a transient plan-read failure) falls to the setup
 * link, never the free upsell, so a paying manager is never shown an upgrade
 * prompt on a billing-read blip. Co-managers inherit paid nav tier from linked
 * workspace owners when their own plan is Free.
 */
function ManagerWorkNumberSetupLabel() {
  return (
    <>
      <span className="sm:hidden" aria-hidden="true">
        Messaging
      </span>
      <span className="hidden sm:inline">Set up messaging</span>
    </>
  );
}

export function ManagerWorkNumberButton({ className }: { className?: string }) {
  const { ready, resolved, statusError, status, retry } =
    useManagerMessagingNumberStatus();

  const btnClass = `shrink-0 ${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim();

  if (!ready) return null;

  if (statusError) {
    return (
      <div
        className="flex min-w-0 items-center gap-2"
        role="alert"
        aria-live="polite"
      >
        <span className="sr-only">Messaging status unavailable.</span>
        <span
          className="hidden text-sm text-muted sm:inline"
          aria-hidden="true"
        >
          Messaging status unavailable.
        </span>
        <Button
          type="button"
          variant="outline"
          className={btnClass}
          data-attr="messaging-status-retry"
          aria-label="Retry messaging status"
          title="Messaging status unavailable. Tap to retry."
          onClick={retry}
        >
          Retry
        </Button>
      </div>
    );
  }

  // Reserve toolbar space immediately; swap to the correct plan state once loaded.
  if (!resolved || !status) {
    return (
      <Button
        type="button"
        variant="outline"
        className={btnClass}
        disabled
        aria-busy="true"
        aria-label="Set up messaging"
        data-attr="messaging-setup-loading"
      >
        <ManagerWorkNumberSetupLabel />
      </Button>
    );
  }

  // Once a number is assigned, the CTA has done its job and disappears.
  if (status.number?.phoneNumber) return null;

  if (status.planTier === "free") {
    return (
      <span
        className="inline-flex shrink-0"
        title="Subscribe to Pro to unlock SMS"
      >
        <Button
          type="button"
          variant="outline"
          className={btnClass}
          disabled
          aria-disabled="true"
          title="Subscribe to Pro to unlock SMS"
          data-attr="messaging-upsell-locked"
          aria-label="Subscribe to Pro to unlock SMS"
        >
          <ManagerWorkNumberSetupLabel />
        </Button>
      </span>
    );
  }

  return (
    <Button
      asChild
      variant="outline"
      className={btnClass}
      data-attr="messaging-open-settings"
    >
      <Link href={MANAGER_MESSAGING_SETTINGS_HREF} aria-label="Set up messaging">
        <ManagerWorkNumberSetupLabel />
      </Link>
    </Button>
  );
}
