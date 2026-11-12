import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSmsConversationRef, type ConversationRef } from "@/lib/communication/conversation-key.server";
import { findThreadByConversation } from "@/lib/communication/conversation-thread.server";
import { phoneKey as telKey } from "@/lib/communication/conversation-key";
import { smsNoticeThreadId } from "@/lib/sms-inbox-notice.server";
import { MANAGER_INBOX_SCOPE } from "@/lib/prospect-spine/thread.server";

/** The conversation ref of a phone in a workspace: the shared resolver's answer, else the plain `tel:` key. Never null. */
export async function prospectPhoneRef(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; phoneE164: string },
): Promise<ConversationRef> {
  const resolved = await resolveSmsConversationRef(db, {
    ownerManagerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    counterpartyPhone: input.phoneE164,
  }).catch(() => null);
  if (resolved) return resolved;
  const key = telKey(input.phoneE164);
  return { workspaceId: input.workspaceId, key, keys: [key], flagged: null };
}

/**
 * The ONE thread this phone already has in the workspace (keyed row, whatever its id), else the deterministic id the
 * thread would be created under. Used by the alert (before the turn is written) and by every writer.
 */
export async function locateThreadId(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; phoneE164: string },
): Promise<string> {
  const ref = await prospectPhoneRef(db, input);
  const existing = await findThreadByConversation(
    db,
    { scope: MANAGER_INBOX_SCOPE, ownerUserId: input.ownerUserId, participantEmail: null },
    ref,
  ).catch(() => null);
  return existing?.id ?? smsNoticeThreadId(input.ownerUserId, input.phoneE164);
}
