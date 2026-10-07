import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { grantedHouses, type OwnerGrant } from "@/lib/property-owner/access.server";
import type { OwnerConversation, OwnerMessage } from "@/lib/property-owner/projection";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const MAX_BODY = 4000;


/** Memberships where Messages is on for at least one granted house. */
function messagingGrants(grants: OwnerGrant[]): OwnerGrant[] {
  const on = new Set(grantedHouses(grants, "messages").map((h) => `${h.managerUserId}:${h.propertyId}`));
  return grants.filter((g) => g.houses.some((h) => h.messages && on.has(`${g.managerUserId}:${h.propertyId}`)));
}

async function emailOf(db: SupabaseClient, userId: string): Promise<{ email: string; name: string }> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", userId).maybeSingle();
  return { email: String(data?.email ?? "").trim().toLowerCase(), name: String(data?.full_name ?? "").trim() };
}

/**
 * The owner's OWN conversation with each manager that turned Messages on.
 *
 * Read from the owner's own inbox rows (`owner_user_id` = the owner) whose
 * counterparty is exactly that manager. Resident, vendor and teammate threads
 * are different counterparties and are never selected; a thread's messages go
 * out as body, time and direction only (no names, no attachments).
 */
export async function loadOwnerConversations(
  db: SupabaseClient,
  ownerUserId: string,
  grants: OwnerGrant[],
): Promise<OwnerConversation[]> {
  const out: OwnerConversation[] = [];
  const me = await emailOf(db, ownerUserId);
  for (const grant of messagingGrants(grants)) {
    const manager = await emailOf(db, grant.managerUserId);
    const messages: OwnerMessage[] = [];
    if (manager.email) {
      const { data, error } = await db
        .from("portal_inbox_thread_records")
        .select("row_data")
        .eq("scope", MANAGER_INBOX_SCOPE)
        .eq("owner_user_id", ownerUserId)
        .ilike("participant_email", manager.email)
        .limit(20);
      if (error) throw new Error("Could not load messages.");
      for (const row of data ?? []) {
        const list = (row.row_data as { messages?: unknown } | null)?.messages;
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
          const m = raw as { id?: unknown; body?: unknown; at?: unknown; outbound?: unknown; from?: unknown };
          const body = typeof m.body === "string" ? m.body : "";
          if (!body.trim()) continue;
          const fromMe =
            m.outbound === true ||
            (m.outbound === undefined && String(m.from ?? "").trim().toLowerCase() === me.email && me.email !== "");
          messages.push({ id: String(m.id ?? ""), body, at: String(m.at ?? ""), fromMe });
        }
      }
    }
    messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    out.push({ conversationId: grant.linkId, messages });
  }
  return out;
}

export class OwnerMessageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Send one message from the owner to the manager of one of their OWN
 * memberships. The recipient is never taken from the request: the
 * conversation id is looked up among the owner's grants, and a conversation
 * whose Messages key is off is refused like one that does not exist.
 */
export async function sendOwnerMessage(
  db: SupabaseClient,
  ownerUserId: string,
  grants: OwnerGrant[],
  input: { conversationId: string; body: string },
): Promise<void> {
  const text = input.body.trim();
  if (!text) throw new OwnerMessageError("Write a message first.", 400);
  if (text.length > MAX_BODY) throw new OwnerMessageError("That message is too long.", 400);
  const grant = messagingGrants(grants).find((g) => g.linkId === input.conversationId);
  if (!grant) throw new OwnerMessageError("Not found.", 404);
  const me = await emailOf(db, ownerUserId);
  const result = await deliverPortalInboxMessage(db, {
    senderUserId: ownerUserId,
    senderEmail: me.email,
    fromName: me.name || "Property owner",
    subject: "Message from a property owner",
    text,
    toUserIds: [grant.managerUserId],
    deliverToPortalInbox: true,
    deliverViaEmail: false,
    deliverViaSms: false,
    senderRole: "manager",
  });
  if (!result.ok) throw new OwnerMessageError("Could not send your message.", 502);
}
