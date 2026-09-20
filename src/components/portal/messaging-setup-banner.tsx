"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";

/**
 * Per-device "I've seen it" for the notice. A convenience, not state: it
 * clears when the browser does, and the dashboard's attention list keeps the
 * same row until a number is actually assigned.
 */
const DISMISSED_KEY = "proplane.messaging-setup-notice.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Portal-wide "set up messaging" notice, in the same slot as the free-plan
 * banner (`pro-plan-banner.tsx`) so a manager sees it on EVERY page rather than
 * only on the one listing preview that used to carry it.
 *
 * Without a work number the product silently drops a whole channel: listings
 * render no Text button, applicants and residents cannot text in, and nothing
 * on screen says why. The listing preview said so on one tab; a manager who
 * never opens that tab never learns.
 *
 * The condition is the SAME one `ManagerWorkNumberButton` uses — an assigned
 * `phoneNumber`, nothing else — deliberately, so "does this account still need
 * messaging?" has one answer in the product rather than two that can disagree.
 * In particular it does NOT hide on a parked or in-flight request: until a
 * number is assigned, renters cannot text this manager, which is exactly what
 * the banner says. Settings is where the difference between "waiting on the
 * carrier" and "waiting on eligibility" is explained, and that is where the
 * link goes.
 *
 * Two states render nothing:
 *  - unresolved or failed status → no flash, and no bar to argue with;
 *    Communication's own CTA owns the retry affordance.
 *  - `planTier === "free"` → messaging is a paid feature, and that account is
 *    already carrying the upgrade banner in this very slot. `"unknown"` (a
 *    transient plan-read failure) is NOT free — it falls through to the prompt,
 *    never to silence, matching `ManagerWorkNumberButton`.
 */
export function ManagerMessagingSetupBanner() {
  const { resolved, statusError, status } = useManagerMessagingNumberStatus();
  const pathname = usePathname();
  // Read after mount so the server and the first client paint agree.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    const seen = readDismissed();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setDismissed(seen);
  }, []);

  if (!resolved || statusError || !status) return null;
  // Communication's own header carries the same "Set up messaging" action;
  // the notice above it said the same thing twice on one screen.
  if (pathname?.startsWith("/portal/communication")) return null;
  if (status.number?.phoneNumber) return null;
  if (status.planTier === "free") return null;
  if (dismissed !== false) return null;

  /*
   * One line, a blue rail, and a way to close it. It used to be a full-width
   * red band on every page — red is for something that has gone wrong, and a
   * feature not yet set up has not. The dashboard's attention list carries the
   * same item, so closing this loses nothing.
   */
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-[max(1rem,env(safe-area-inset-left,0px))] py-1.5 pe-[max(0.5rem,env(safe-area-inset-right,0px))] text-[13px] leading-snug text-foreground lg:px-6"
      data-attr="manager-messaging-setup-banner"
      role="status"
    >
      <span className="h-5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
      {/* One line + a text link — never truncated, never a pill button
          (PLAN-0920-1058 area 1d, "1d · The pop-up" § icon chrome rule applied
          to every utility, banners included). */}
      <p className="min-w-0 font-medium">
        Phone number not set up.{" "}
        <Link
          href={MANAGER_MESSAGING_SETTINGS_HREF}
          data-attr="manager-messaging-setup-banner-link"
          // PRP-350: still a ≥44px phone tap target, just no pill chrome around it.
          className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-2 hover:text-primary/80"
        >
          Set up messaging
        </Link>
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            // A browser that refuses storage still gets the notice closed for this page.
          }
          setDismissed(true);
        }}
        aria-label="Dismiss"
        data-attr="manager-messaging-setup-banner-dismiss"
        className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-accent/40 hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
