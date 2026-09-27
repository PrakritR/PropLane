"use client";

import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ManagerReachabilityLines } from "@/lib/manager-reachability-for-resident";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";
import { trimmedText } from "@/lib/trimmed-text";

/**
 * The Seattle Homes sandbox's own reachability lines — never fetched for
 * real from `/demo` (both routes below are auth-gated, and a signed-in
 * visitor previewing `/demo` in the same browser must never see their OWN
 * real number/email surfaced on a public sandbox page).
 */
const DEMO_REACHABILITY_LINES: ManagerReachabilityLines = {
  workPhoneLabel: "(206) 555-0100",
  assistantEmail: "seattlehomes@proplane.chat",
};

/** Load the logged-in manager's work SMS line and assistant email for welcome previews. */
export async function fetchManagerReachabilityForWelcome(): Promise<ManagerReachabilityLines> {
  if (isDemoModeActive()) return DEMO_REACHABILITY_LINES;
  try {
    const [numberRes, emailRes] = await Promise.all([
      fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" }),
      fetch("/api/manager/assistant-email", { credentials: "include", cache: "no-store" }),
    ]);
    const numberBody = numberRes.ok
      ? ((await numberRes.json().catch(() => null)) as {
          canSend?: boolean;
          number?: { phoneNumber?: string | null };
        } | null)
      : null;
    const emailBody = emailRes.ok
      ? ((await emailRes.json().catch(() => null)) as {
          canUse?: boolean;
          address?: string | null;
        } | null)
      : null;

    const phoneE164 =
      numberBody?.canSend && trimmedText(numberBody.number?.phoneNumber)
        ? trimmedText(numberBody.number?.phoneNumber)
        : null;

    return {
      workPhoneLabel: phoneE164 ? formatManagerMessagingPhone(phoneE164) || phoneE164 : null,
      // `canUse` is the email's `canSend`: only ever preview an address that
      // can actually carry a reply.
      assistantEmail: emailBody?.canUse ? trimmedText(emailBody.address) || null : null,
    };
  } catch {
    return { workPhoneLabel: null, assistantEmail: null };
  }
}
