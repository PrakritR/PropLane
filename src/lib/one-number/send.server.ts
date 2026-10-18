import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineRole, SharedLineSend, SharedLineSendResult } from "@/lib/one-number/contracts";
import { appendSignOff, smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";

const COUNTERPARTY_FOR_ROLE: Record<SharedLineRole, SmsCounterpartyRole> = {
  manager: "manager",
  resident: "resident",
  vendor: "vendor",
  applicant: "applicant",
  prospect: "prospect",
};

/** Map a transport refusal onto the contract's closed set of reasons. */
export function sharedLineFailureReason(error: string | undefined): {
  reason: Exclude<Extract<SharedLineSendResult, { ok: false }>["reason"], "not_shared_mode" | "no_shared_number">;
  detail?: string;
} {
  const code = String(error ?? "").trim();
  if (code === "recipient_opted_out" || code === "protected_account_shielded") return { reason: "opted_out", detail: code };
  if (code === "quiet_hours") return { reason: "quiet_hours" };
  if (
    code.startsWith("comms_billing_") ||
    code.startsWith("credit_") ||
    code === "credit_unavailable" ||
    code.includes("budget")
  ) {
    return { reason: "budget", detail: code };
  }
  return { reason: "provider_error", detail: code || undefined };
}

/**
 * The one outbound door on the shared line. Every text the router, agents,
 * alerts or the inbox send while a workspace is on the shared line goes
 * through here: it takes the SAME outbox -> dispatcher path as a work-number
 * send (consent, quiet hours, protected-account shield, test capture, the
 * workspace wallet reservation, delivery status), with the shared number as the
 * From. The text is made GSM-7 and a human reply is signed.
 */
export async function sendSharedLineMessage(
  db: SupabaseClient,
  send: SharedLineSend,
): Promise<SharedLineSendResult> {
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ok: false, reason: "not_shared_mode" };
  if (!config.sharedNumber) return { ok: false, reason: "no_shared_number" };
  if (!workspaceOnSharedLine(config, send.workspaceId)) return { ok: false, reason: "not_shared_mode" };

  const text = toGsm7(appendSignOff(String(send.body ?? ""), send.signOff ?? null));
  if (!text) return { ok: false, reason: "provider_error", detail: "empty_body" };
  const segments = smsSegmentCount(text);

  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const result = await sendFromManagerWorkNumber({
    managerUserId: send.ownerUserId,
    workspaceId: send.workspaceId,
    to: send.toPhone,
    text,
    source: "work_number",
    sendClass: "transactional",
    counterpartyRole: COUNTERPARTY_FOR_ROLE[send.role],
    purpose: "shared_line_message",
    dedupeKey: `shared-line:${send.idempotencyKey}`,
  });

  if (result.ok) {
    return { ok: true, messageSid: result.sid ?? result.outboxId ?? "", segments };
  }
  const failure = sharedLineFailureReason(result.error);
  return { ok: false, reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) };
}
