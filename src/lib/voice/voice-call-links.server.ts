import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { workspaceOnSharedLine, loadSharedLineConfig } from "@/lib/one-number/config.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { alertOpsOfInboundText } from "@/lib/one-number/inbound-alert.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/twilio";
import type { ProspectLinkKind } from "@/lib/prospect-replies";
import { buildCallFollowUpText, parseLinkNote } from "@/lib/voice/voice-call-flow";
import { VOICE_CALL_NOTE_SID_PREFIX } from "@/lib/voice/voice-call-notes";
import type { ResolvedVoiceCall } from "@/lib/voice/voice-call-routing.server";

type Resolved = Extract<ResolvedVoiceCall, { ok: true }>;

function allowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const origin of [PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl()]) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      /* an unparsable origin is not an allowed host */
    }
  }
  return [...hosts];
}

/** The pages the call offered, read back from its own notes (the thread staff can see), in the order they were offered. */
export async function loadCallOfferedPages(
  db: SupabaseClient,
  args: { managerUserId: string; callSid: string },
): Promise<Array<{ kind: ProspectLinkKind; url: string }>> {
  const callSid = args.callSid.trim();
  if (!callSid) return [];
  const { data, error } = await db
    .from("manager_sms_messages")
    .select("body, created_at")
    .eq("manager_user_id", args.managerUserId)
    .like("message_sid", `${VOICE_CALL_NOTE_SID_PREFIX}${callSid}:links:%`)
    .order("created_at", { ascending: true });
  if (error) return [];
  const hosts = allowedHosts();
  const pages: Array<{ kind: ProspectLinkKind; url: string }> = [];
  for (const row of data ?? []) {
    for (const host of hosts) pages.push(...parseLinkNote(String((row as { body?: unknown }).body ?? ""), host));
  }
  const seen = new Set<string>();
  // A call about two homes texts both homes' pages, but never more than four.
  return pages.filter((page) => (seen.has(page.url) ? false : (seen.add(page.url), true))).slice(-4);
}

export type CallLinksResult = { sent: boolean; reason?: string };

/**
 * After the call: text the caller the pages they asked for, from the line they dialed, through the normal outbound path
 * (consent, quiet hours, opt-out, credit reservation). One text per call: the key is the call's own sid, so a retried
 * status callback never sends twice. Only a PROSPECT is texted links; a resident or a manager already has the portal.
 */
export async function sendCallFollowUpLinks(
  db: SupabaseClient,
  args: { resolved: Resolved; fromPhone: string; callSid: string },
): Promise<CallLinksResult> {
  const { resolved } = args;
  if (resolved.route.kind !== "prospect") return { sent: false, reason: "not_a_prospect" };
  const to = normalizeE164(args.fromPhone);
  if (!to) return { sent: false, reason: "no_caller_number" };
  const pages = await loadCallOfferedPages(db, { managerUserId: resolved.managerId, callSid: args.callSid });
  const text = buildCallFollowUpText(pages);
  if (!text) return { sent: false, reason: "nothing_offered" };
  const conversationKey = buildConversationKey({ ownerManagerUserId: resolved.managerId, role: "prospect", counterpartyPhone: to });
  const dedupeKey = `voice-links:${args.callSid}`;

  if (resolved.line === "shared" && resolved.workspaceId) {
    const config = await loadSharedLineConfig(db);
    if (workspaceOnSharedLine(config, resolved.workspaceId)) {
      const sent = await sendSharedLineMessage(db, {
        workspaceId: resolved.workspaceId,
        ownerUserId: resolved.managerId,
        toPhone: to,
        body: text,
        role: "prospect",
        idempotencyKey: dedupeKey,
        delivery: { purpose: "voice_call_links", conversationKey },
      });
      return sent.ok ? { sent: true } : { sent: false, reason: sent.reason };
    }
  }
  const result = await sendFromManagerWorkNumber({
    managerUserId: resolved.managerId,
    ...(resolved.workspaceId ? { workspaceId: resolved.workspaceId } : {}),
    to,
    text,
    fromNumber: resolved.workNumber,
    source: "automated",
    counterpartyRole: "prospect",
    conversationKey,
    dedupeKey,
    purpose: "manager_conversation",
    actorUserId: resolved.managerId,
  });
  return result.ok ? { sent: true } : { sent: false, reason: String(result.error ?? "send_failed") };
}

/** One line to PropLane's alert phones that a call happened (the same alert an inbound text raises), best effort. */
export async function alertOpsOfCall(
  db: SupabaseClient,
  args: { resolved: Resolved; fromPhone: string; callSid: string; gist: string },
): Promise<"sent" | "skipped"> {
  try {
    return await alertOpsOfInboundText(db, {
      workspaceId: args.resolved.workspaceId,
      managerId: args.resolved.managerId,
      fromPhone: args.fromPhone,
      body: args.gist,
      messageSid: `voice:${args.callSid}`,
      onPropLaneLine: args.resolved.line === "shared" || args.resolved.billing.platform !== null,
    });
  } catch {
    return "skipped";
  }
}
