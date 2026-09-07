"use client";

import Link from "next/link";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { MANAGER_MESSAGING_SETTINGS_HREF } from "@/lib/sms/manager-messaging-number";

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

  if (!resolved || statusError || !status) return null;
  if (status.number?.phoneNumber) return null;
  if (status.planTier === "free") return null;

  return (
    <div
      className="shrink-0 border-b border-red-300 bg-red-50 px-[max(1rem,env(safe-area-inset-left,0px))] py-2.5 pe-[max(1rem,env(safe-area-inset-right,0px))] text-center text-xs leading-snug text-red-950 sm:text-sm lg:px-8"
      data-attr="manager-messaging-setup-banner"
      role="status"
    >
      <p className="font-medium">
        Set up messaging so renters can text you about your homes.{" "}
        <Link
          href={MANAGER_MESSAGING_SETTINGS_HREF}
          data-attr="manager-messaging-setup-banner-link"
          className="font-semibold text-red-700 underline underline-offset-2 hover:text-red-900"
        >
          Set up messaging
        </Link>
      </p>
    </div>
  );
}
