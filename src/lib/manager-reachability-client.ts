"use client";

import type { ManagerReachabilityLines } from "@/lib/manager-reachability-for-resident";
import { formatManagerMessagingPhone } from "@/lib/sms/manager-messaging-number";
import { trimmedText } from "@/lib/trimmed-text";

/** Load the logged-in manager's work SMS line and assistant email for welcome previews. */
export async function fetchManagerReachabilityForWelcome(): Promise<ManagerReachabilityLines> {
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
      ? ((await emailRes.json().catch(() => null)) as { address?: string | null } | null)
      : null;

    const phoneE164 =
      numberBody?.canSend && trimmedText(numberBody.number?.phoneNumber)
        ? trimmedText(numberBody.number?.phoneNumber)
        : null;

    return {
      workPhoneLabel: phoneE164 ? formatManagerMessagingPhone(phoneE164) || phoneE164 : null,
      assistantEmail: trimmedText(emailBody?.address) || null,
    };
  } catch {
    return { workPhoneLabel: null, assistantEmail: null };
  }
}
