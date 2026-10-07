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
  const allowed = messagingGrants(grants);
  if (allowed.length === 0) return out;
  const me = await emailOf(db, ownerUserId);
  // The owner's own inbox rows, read ONCE: the query never depended on the
  // membership (only on the owner), and the per-manager narrowing below is the
  // counterparty comparison.
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("row_data, participant_email, created_at")
    .eq("scope", MANAGER_INBOX_SCOPE)
    .eq("owner_user_id", ownerUserId)
    .limit(200);
  if (error) throw new Error("Could not load messages.");
  // Rows oldest first; within a row the root comes before its later turns.
  // (Turn `at` labels are display strings, so they are never sorted on.)
  const rows = [...(data ?? [])].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const grant of allowed) {
    const manager = await emailOf(db, grant.managerUserId);
    const messages: OwnerMessage[] = [];
    if (manager.email) {
      for (const row of rows) {
        const rowData = (row.row_data ?? {}) as { messages?: unknown; email?: unknown; body?: unknown; folder?: unknown; id?: unknown };
        // Only the counterparty is this manager. `row_data.email` is the person
        // the thread is WITH on BOTH copies; `participant_email` is the owner's
        // own address on a received row, so it is a fallback only and never
        // when it is the owner themselves (that is what hid the manager's
        // replies from the owner's own thread).
        const onRow = String(rowData.email ?? "").trim().toLowerCase();
        const participant = String(row.participant_email ?? "").trim().toLowerCase();
        const counterparty = onRow || (participant && participant !== me.email ? participant : "");
        if (counterparty !== manager.email) continue;
        // The row's own body is the first turn (`folder` says which side wrote
        // it); later turns of the same conversation append to `messages`.
        const rootBody = typeof rowData.body === "string" ? rowData.body : "";
        if (rootBody.trim()) {
          messages.push({
            id: String(rowData.id ?? ""),
            body: rootBody,
            at: String(row.created_at ?? ""),
            fromMe: rowData.folder === "sent",
          });
        }
        const list = rowData.messages;
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
    // The manager comes from the owner's own membership, never the request.
    recipientsAuthorizedByCaller: true,
  });
  if (!result.ok) throw new OwnerMessageError("Could not send your message.", 502);
}
