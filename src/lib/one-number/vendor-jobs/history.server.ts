import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The PropLane-line chat history of one phone (W24): an `agent_sessions` row (kind `vendor_line_sms`, one per service
 * owner + phone) with its `agent_messages`. The same stores the prospect path uses, so the admin / service owner can
 * read it, the next text reloads it, and a personal-number upgrade can copy it (`copyPropLaneLineHistory`).
 * Every write is keyed on a MessageSid, so a webhook retry adds nothing. A missing table or a failed write never
 * blocks the reply: history is a record, not a gate.
 */
export const VENDOR_LINE_SESSION_KIND = "vendor_line_sms";
export const VENDOR_LINE_HISTORY_LIMIT = 12;

export type LineMessage = { role: "user" | "assistant"; content: string; sid: string | null; createdAt: string };

type Row = Record<string, unknown>;

export async function findOrCreateLineSession(
  db: SupabaseClient,
  input: { ownerUserId: string; phoneE164: string; vendorUserId?: string | null },
): Promise<string | null> {
  try {
    const find = async () => {
      const { data } = await db
        .from("agent_sessions")
        .select("id, vendor_user_id")
        .eq("landlord_id", input.ownerUserId)
        .eq("kind", VENDOR_LINE_SESSION_KIND)
        .eq("vendor_phone_e164", input.phoneE164)
        .limit(1)
        .maybeSingle();
      return data as Row | null;
    };
    const existing = await find();
    if (existing?.id) {
      // The vendor signed up since the last text: bind the session to their account once.
      if (input.vendorUserId && !existing.vendor_user_id) {
        await db.from("agent_sessions").update({ vendor_user_id: input.vendorUserId, user_id: input.vendorUserId }).eq("id", String(existing.id));
      }
      return String(existing.id);
    }
    const { data, error } = await db
      .from("agent_sessions")
      .insert({
        landlord_id: input.ownerUserId,
        user_id: input.vendorUserId ?? null,
        kind: VENDOR_LINE_SESSION_KIND,
        vendor_user_id: input.vendorUserId ?? null,
        vendor_phone_e164: input.phoneE164,
        status: "active",
      })
      .select("id")
      .maybeSingle();
    if (data?.id) return String((data as Row).id);
    if (error?.code === "23505") return String((await find())?.id ?? "") || null;
    return null;
  } catch {
    return null;
  }
}

export async function loadLineHistory(
  db: SupabaseClient,
  input: { ownerUserId: string; phoneE164: string; limit?: number },
): Promise<{ sessionId: string | null; messages: LineMessage[] }> {
  try {
    const { data: session } = await db
      .from("agent_sessions")
      .select("id")
      .eq("landlord_id", input.ownerUserId)
      .eq("kind", VENDOR_LINE_SESSION_KIND)
      .eq("vendor_phone_e164", input.phoneE164)
      .limit(1)
      .maybeSingle();
    const sessionId = (session as Row | null)?.id ? String((session as Row).id) : null;
    if (!sessionId) return { sessionId: null, messages: [] };
    const { data } = await db
      .from("agent_messages")
      .select("role, content, tool_trace, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(input.limit ?? VENDOR_LINE_HISTORY_LIMIT);
    const messages = ((data ?? []) as Row[])
      .reverse()
      .map((row) => ({
        role: (row.role === "assistant" ? "assistant" : "user") as LineMessage["role"],
        content: String(row.content ?? ""),
        sid: typeof (row.tool_trace as Row | null)?.sid === "string" ? String((row.tool_trace as Row).sid) : null,
        createdAt: String(row.created_at ?? ""),
      }));
    return { sessionId, messages };
  } catch {
    return { sessionId: null, messages: [] };
  }
}

/** Append one turn (the vendor's text and our reply), once per MessageSid. */
export async function appendLineTurn(
  db: SupabaseClient,
  input: { sessionId: string; ownerUserId: string; inbound: string; reply: string | null; messageSid: string; now?: Date },
): Promise<boolean> {
  try {
    const sid = input.messageSid.trim();
    if (sid) {
      const { data } = await db.from("agent_messages").select("id").eq("session_id", input.sessionId).eq("tool_trace->>sid", sid).limit(1);
      if ((data ?? []).length > 0) return false;
    }
    const at = (input.now ?? new Date()).toISOString();
    const rows: Row[] = [
      { session_id: input.sessionId, landlord_id: input.ownerUserId, role: "user", content: input.inbound.slice(0, 2000), channel: "sms", tool_trace: { sid, source: "propline_line" }, created_at: at },
    ];
    if (input.reply) {
      rows.push({
        session_id: input.sessionId, landlord_id: input.ownerUserId, role: "assistant", content: input.reply.slice(0, 2000), channel: "sms",
        tool_trace: { sid: sid ? `${sid}:reply` : "", source: "propline_line" }, created_at: new Date(Date.parse(at) + 1).toISOString(),
      });
    }
    const { error } = await db.from("agent_messages").insert(rows);
    if (error) return false;
    await db.from("agent_sessions").update({ updated_at: at }).eq("id", input.sessionId);
    return true;
  } catch {
    return false;
  }
}
