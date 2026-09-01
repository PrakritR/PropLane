"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  MANAGER_MESSAGING_SETTINGS_HREF,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";

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
export function ManagerWorkNumberButton({ className }: { className?: string }) {
  const [status, setStatus] = useState<ManagerMessagingNumberStatus | null>(
    null,
  );
  const [resolved, setResolved] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setResolved(false);
    setStatusError(false);
    void fetch("/api/manager/messaging-number", {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Messaging status request failed.");
        return res.json();
      })
      .then((body) => {
        if (!active) return;
        setStatus((body ?? null) as ManagerMessagingNumberStatus | null);
        setResolved(true);
      })
      .catch(() => {
        if (!active) return;
        setStatusError(true);
        setResolved(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const btnClass = `shrink-0 ${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim();

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
          onClick={() => setAttempt((a) => a + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  // Until resolved, render nothing rather than flash the wrong plan state.
  if (!resolved || !status) return null;

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
          <span className="sm:hidden" aria-hidden="true">
            Messaging
          </span>
          <span className="hidden sm:inline">Set up messaging</span>
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
        <span className="sm:hidden" aria-hidden="true">
          Messaging
        </span>
        <span className="hidden sm:inline">Set up messaging</span>
      </Link>
    </Button>
  );
}
