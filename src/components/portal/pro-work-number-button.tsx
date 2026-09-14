"use client";

import Link from "next/link";
import { Phone, RefreshCw } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";

/**
 * Communication-toolbar entry point to work-number setup. A phone glyph with an
 * amber dot — the dot says "still to do" without a word (PLAN-0914-1345).
 * Three states, keyed on the account's authoritative plan (`planTier`) and
 * whether a number is already assigned:
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
  const { ready, resolved, statusError, status, retry } =
    useManagerMessagingNumberStatus();

  if (!ready) return null;

  if (statusError) {
    return (
      <span className="inline-flex shrink-0" role="alert" aria-live="polite">
        <span className="sr-only">Messaging status unavailable.</span>
        <PortalIconAction
          icon={RefreshCw}
          label="Retry messaging status"
          badge="warn"
          className={className}
          data-attr="messaging-status-retry"
          onClick={retry}
        />
      </span>
    );
  }

  // Reserve toolbar space immediately; swap to the correct plan state once loaded.
  if (!resolved || !status) {
    return (
      <PortalIconAction
        icon={Phone}
        label="Set up messaging"
        className={className}
        disabled
        aria-busy="true"
        data-attr="messaging-setup-loading"
      />
    );
  }

  // Once a number is assigned, the CTA has done its job and disappears.
  if (status.number?.phoneNumber) return null;
  // A co-manager never sets up a number: the workspace's line is the owner's
  // to request. The header card says whose job that is when it is missing.
  if (status.workspaceRole === "co_manager") return null;

  if (status.planTier === "free") {
    return (
      <span className="inline-flex shrink-0" title="Subscribe to Pro to unlock SMS">
        <PortalIconAction
          icon={Phone}
          label="Subscribe to Pro to unlock SMS"
          className={className}
          disabled
          aria-disabled="true"
          data-attr="messaging-upsell-locked"
        />
      </span>
    );
  }

  // A link styled as the icon action: the destination is a settings route, not a modal.
  return (
    <Link
      href={MANAGER_MESSAGING_SETTINGS_HREF}
      aria-label="Set up messaging"
      title="Set up messaging"
      data-attr="messaging-open-settings"
      data-slot="portal-icon-action"
      className={`relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-foreground/80 outline-none transition hover:bg-[var(--secondary)]/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30 md:size-9 ${className ?? ""}`.trim()}
    >
      <Phone className="size-[18px]" strokeWidth={1.75} aria-hidden />
      <span aria-hidden data-slot="portal-icon-badge" data-tone="warn" className="absolute right-1 top-1 size-2 rounded-full bg-amber-500 ring-2 ring-card" />
    </Link>
  );
}
