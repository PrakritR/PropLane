import "server-only";

/**
 * Memory for a resident who emails the work address.
 *
 * The manager and prospect branches of the work email already remember: the
 * manager through their `manager_email` session, the prospect through
 * `leasing_email`. The resident branch called the inbox auto-responder with no
 * history at all, so a resident who wrote "and the one after that?" was
 * answered by a model that had never seen the first email. This gives the
 * resident branch the same shape as the prospect's — one `agent_sessions` row
 * per (workspace owner, resident email), the last twelve turns handed to the
 * model, every turn persisted.
 *
 * Keyed on the OWNER of the workspace the address answers for, never the
 * mailbox row: two co-managers' legacy addresses that both collapse to one
 * owner must share the resident's history, or the resident's memory would
 * depend on which alias they happened to write to.
 *
 * `vendor_phone_e164` holds the resident's email — the same column the
 * `leasing_email` kind uses as its conversation key, and for the same reason:
 * it is the identity column the session table has, and a separate `kind` is
 * what keeps an emailing resident from ever sharing a thread with a texting
 * one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_HISTORY_MESSAGES, type InboxTurnMessage } from "@/lib/agent/inbox-auto-respond.server";

export const RESIDENT_EMAIL_SESSION_KIND = "resident_email";

export type ResidentEmailSession = { id: string; landlord_id: string };

export async function findOrCreateResidentEmailSession(
  db: SupabaseClient,
  args: { landlordId: string; residentEmail: string },
): Promise<ResidentEmailSession | null> {
  const landlordId = args.landlordId.trim();
  const email = args.residentEmail.trim().toLowerCase();
  if (!landlordId || !email.includes("@")) return null;

  const select = "id, landlord_id";
  const read = async () => {
    const { data } = await db
      .from("agent_sessions")
      .select(select)
      .eq("kind", RESIDENT_EMAIL_SESSION_KIND)
      .eq("landlord_id", landlordId)
      .eq("vendor_phone_e164", email)
      .maybeSingle();
    return (data as ResidentEmailSession | null) ?? null;
  };

  const existing = await read();
  if (existing) return existing;

  const { data: created, error } = await db
    .from("agent_sessions")
    .insert({
      landlord_id: landlordId,
      user_id: null,
      kind: RESIDENT_EMAIL_SESSION_KIND,
      vendor_phone_e164: email,
      status: "active",
    })
    .select(select)
    .maybeSingle();
  // Race on the unique index — re-read rather than fail the turn.
  if (error) return error.code === "23505" ? read() : null;
  return (created as ResidentEmailSession | null) ?? null;
}

/** The last turns of this resident's email conversation, oldest first. */
export async function loadResidentEmailHistory(
  db: SupabaseClient,
  sessionId: string,
): Promise<InboxTurnMessage[]> {
  const { data } = await db
    .from("agent_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  return ((data ?? []) as { role: string; content: string }[])
    .reverse()
    .map((row) => ({
      from: row.role === "assistant" ? ("manager" as const) : ("resident" as const),
      body: String(row.content ?? ""),
    }));
}

/**
 * Persist the resident's email so the next turn can see it. Idempotent on the
 * inbound id: a Resend redelivery hits the unique partial index and is a no-op.
 */
export async function recordResidentEmailInbound(
  db: SupabaseClient,
  session: ResidentEmailSession,
  args: { text: string; inboundEmailId: string },
): Promise<void> {
  const { error } = await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "user",
    content: args.text,
    channel: "email",
    source_message_sid: args.inboundEmailId.trim() || null,
  });
  if (error && error.code !== "23505") {
    console.error("resident-email inbound persistence failed", session.id, error.message);
  }
}

export async function recordResidentEmailReply(
  db: SupabaseClient,
  session: ResidentEmailSession,
  args: { text: string; traceId: string | null },
): Promise<void> {
  const reply = args.text.trim();
  if (!reply) return;
  await db.from("agent_messages").insert({
    session_id: session.id,
    landlord_id: session.landlord_id,
    role: "assistant",
    content: reply,
    channel: "agent",
    trace_id: args.traceId,
  });
  await db
    .from("agent_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", session.id);
}
