import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { appendHouseLine } from "@/lib/house-chat/store.server";
import { groupPreferenceCommand } from "@/lib/house-groups/ra-policy";
import type { GroupWebhookMessage } from "@/lib/house-groups/ra.server";
import { recordOptOut } from "@/lib/house-groups/store.server";
import { PROPLANE_IDENTITY } from "@/lib/house-groups/types";
import { parseHouseThreadId } from "@/lib/house-thread-id";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { inboundLineId, readSmsGroupState, smsAuthorLabel } from "./model";
import { postToHouseSmsGroup } from "./post.server";
import { findThreadByConversationSid } from "./store.server";
import { syncHouseSmsGroup, type SmsGroupSyncDeps } from "./sync.server";

export type SmsGroupInboundResult =
  | { handled: false }
  | { handled: true; action: "own_message" | "not_a_member" | "not_current_resident" | "empty" | "appended" | "duplicate" | "left" | "not_active" };

/** A bridged line is plain text; the cap keeps one text from becoming a document in the thread row. */
const INBOUND_MAX_CHARS = 1600;

/**
 * One text typed in a house's SMS group (Conversations `onMessageAdded`, ALREADY signature-verified by the route)
 * becomes one line on the house's in-app chat, drawn as the author's first name and room (staff: first name),
 * never a number. `{ handled: false }` means the Conversation is not a house chat's (the W10 RA groups own those),
 * so the route falls through.
 *
 *  - PropLane's own posts (`Author = proplane`) are never bridged back (no echo loop).
 *  - Only a phone in the stored member list is bridged, and a resident is re-checked against today's occupancy:
 *    a stranger's text, a moved-out resident's, an opted-out resident's are dropped (the move-out triggers a sync).
 *  - Idempotent on the Twilio MessageSid: a retry appends once.
 *  - "leave group" opts a resident out (workspace-wide, the same state a 1:1 "leave group" sets) or drops a
 *    staff phone from this house, removes the phone from the Conversation, and tells the rest. No number is logged.
 */
export async function handleHouseSmsGroupInbound(
  db: SupabaseClient,
  message: GroupWebhookMessage,
  deps: SmsGroupSyncDeps = {},
): Promise<SmsGroupInboundResult> {
  const thread = await findThreadByConversationSid(db, message.conversationSid);
  if (!thread) return { handled: false };
  if (message.author.trim() === PROPLANE_IDENTITY) return { handled: true, action: "own_message" };

  const state = readSmsGroupState(thread.rowData);
  const parsed = parseHouseThreadId(thread.id);
  if (!state || !parsed || state.status !== "active" || state.conversationSid !== message.conversationSid.trim()) {
    return { handled: true, action: "not_active" };
  }
  const authorKey = normalizeConsentPhone(message.author);
  const member = state.members.find((m) => m.phoneKey === authorKey);
  if (!member) return { handled: true, action: "not_a_member" };

  const body = redactSensitiveNumbers(String(message.body ?? "").trim()).text.slice(0, INBOUND_MAX_CHARS);
  if (!body && message.mediaCount === 0) return { handled: true, action: "empty" };

  const sync = (extra: { removePhoneKeys?: string[] } = {}) =>
    syncHouseSmsGroup(db, { workspaceId: parsed.workspaceId, propertyId: parsed.propertyId, ...extra }, deps);

  if (member.kind === "resident") {
    // Re-derived from occupancy on every text: a resident who moved out, left or texted STOP is no longer a member.
    // An unreadable occupancy read drops the text (and bridges nothing) rather than guessing a member.
    let live = false;
    try {
      const candidates = deps.loadCandidates
        ? await deps.loadCandidates(parsed.propertyId)
        : await (await import("@/lib/house-groups/residents.server")).loadHouseResidentCandidates(db, {
            ownerUserId: parsed.ownerManagerUserId,
            workspaceId: parsed.workspaceId,
            propertyId: parsed.propertyId,
            today: (await import("@/lib/house-groups/time")).pacificDayKey(new Date()),
          });
      live = candidates.some((c) => c.phoneKey === authorKey && c.longTerm && !c.optedOut && !c.stopped);
    } catch {
      return { handled: true, action: "not_current_resident" };
    }
    if (!live) {
      await sync().catch(() => undefined);
      return { handled: true, action: "not_current_resident" };
    }
  }

  if (groupPreferenceCommand(body) === "leave") {
    if (member.kind === "resident") await recordOptOut(db, parsed.workspaceId, authorKey);
    await sync({ removePhoneKeys: [authorKey] }).catch(() => undefined);
    await postToHouseSmsGroup(
      db,
      {
        workspaceId: parsed.workspaceId,
        propertyId: parsed.propertyId,
        ownerUserId: parsed.ownerManagerUserId,
        text: `${member.firstName.trim() || "A housemate"} left the house text.`,
        kind: "notice",
        idempotencyKey: `sms-group-left:${message.messageSid}`,
      },
      deps.post,
    ).catch(() => undefined);
    return { handled: true, action: "left" };
  }

  const appended = await appendHouseLine(db, thread.id, {
    id: inboundLineId(message.messageSid),
    from: smsAuthorLabel(member),
    body: body || "(sent a photo)",
    ...(member.userId ? { actorUserId: member.userId } : {}),
  });
  if (!appended.ok) throw new Error("house chat line not saved");
  return { handled: true, action: appended.posted ? "appended" : "duplicate" };
}
