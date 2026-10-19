import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { VENDOR_LINE_SESSION_KIND } from "@/lib/one-number/vendor-jobs/history.server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { normalizeE164 } from "@/lib/phone-e164";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";

/**
 * A vendor or resident takes their own PropLane Number (W24): the chat they already had with the PropLane line comes
 * with them. Two copies, both idempotent and both onto the NEW owner:
 *
 *  - the agent session + messages (a `propline_carryover` session, each message keyed `copiedFrom` its source id), so
 *    the conversation continues with its context;
 *  - the inbox thread (`deliverPortalMessageThreadSide` with a deterministic `propline-copy:<owner>:<message id>`), so
 *    the thread shows the same messages in the person's own Communication.
 *
 * The PropLane-line copy is never changed or removed: it stays the platform's record. A replay, a second activation
 * and a person who never texted the line all end at the same state (nothing new). Never throws into an activation:
 * a failure returns `ok: false` and the next activation retries.
 */
export const CARRYOVER_SESSION_KIND = "propline_carryover";

export type PropLaneLineRole = "vendor" | "resident";

export type CopyHistoryResult = {
  ok: boolean;
  agentMessagesCopied: number;
  inboxMessagesCopied: number;
  reason?: "no_service_owner" | "same_owner" | "invalid_phone" | "failed";
};

type Row = Record<string, unknown>;

const SOURCE_SESSION_KINDS: Record<PropLaneLineRole, string[]> = {
  vendor: [VENDOR_LINE_SESSION_KIND],
  resident: ["leasing_sms"],
};
const SOURCE_THREAD_ROLES: Record<PropLaneLineRole, string[]> = {
  vendor: ["vendor"],
  resident: ["resident", "prospect"],
};

async function propLaneLineNumber(db: SupabaseClient, serviceOwnerId: string): Promise<string | null> {
  const config = await loadSharedLineConfig(db).catch(() => null);
  if (config?.sharedNumber) return config.sharedNumber;
  const { data } = await db
    .from("manager_sms_numbers")
    .select("phone_number")
    .eq("manager_user_id", serviceOwnerId)
    .is("released_at", null)
    .limit(1)
    .maybeSingle();
  return normalizeE164(String((data as Row | null)?.phone_number ?? ""));
}

export async function copyPropLaneLineHistory(
  db: SupabaseClient,
  input: { phoneE164: string; role: PropLaneLineRole; newOwnerId: string; newWorkspaceId?: string | null },
): Promise<CopyHistoryResult> {
  const phone = normalizeE164(input.phoneE164);
  if (!phone) return { ok: false, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "invalid_phone" };
  const newOwnerId = input.newOwnerId.trim();
  try {
    const serviceOwnerId = await readPlatformServiceOwnerId(db);
    if (!serviceOwnerId) return { ok: true, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "no_service_owner" };
    if (serviceOwnerId === newOwnerId) return { ok: true, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "same_owner" };

    const agentMessagesCopied = await copyAgentHistory(db, { serviceOwnerId, phone, role: input.role, newOwnerId });
    const inboxMessagesCopied = await copyInboxThread(db, { serviceOwnerId, phone, role: input.role, newOwnerId, newWorkspaceId: input.newWorkspaceId ?? null });
    return { ok: true, agentMessagesCopied, inboxMessagesCopied };
  } catch (error) {
    console.error("propline line history copy failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "failed" };
  }
}

async function copyAgentHistory(
  db: SupabaseClient,
  input: { serviceOwnerId: string; phone: string; role: PropLaneLineRole; newOwnerId: string },
): Promise<number> {
  const { data: sources } = await db
    .from("agent_sessions")
    .select("id")
    .eq("landlord_id", input.serviceOwnerId)
    .in("kind", SOURCE_SESSION_KINDS[input.role])
    .eq("vendor_phone_e164", input.phone);
  const sourceIds = ((sources ?? []) as Row[]).map((r) => String(r.id));
  if (sourceIds.length === 0) return 0;

  const { data: messages } = await db
    .from("agent_messages")
    .select("id, role, content, channel, created_at")
    .in("session_id", sourceIds)
    .order("created_at", { ascending: true })
    .limit(500);
  const rows = (messages ?? []) as Row[];
  if (rows.length === 0) return 0;

  const find = async () => {
    const { data } = await db
      .from("agent_sessions")
      .select("id")
      .eq("landlord_id", input.newOwnerId)
      .eq("kind", CARRYOVER_SESSION_KIND)
      .eq("vendor_phone_e164", input.phone)
      .limit(1)
      .maybeSingle();
    return (data as Row | null)?.id ? String((data as Row).id) : null;
  };
  let sessionId = await find();
  if (!sessionId) {
    const { data, error } = await db
      .from("agent_sessions")
      .insert({ landlord_id: input.newOwnerId, user_id: input.newOwnerId, kind: CARRYOVER_SESSION_KIND, vendor_phone_e164: input.phone, status: "active" })
      .select("id")
      .maybeSingle();
    sessionId = (data as Row | null)?.id ? String((data as Row).id) : error?.code === "23505" ? await find() : null;
  }
  if (!sessionId) throw new Error("carryover session unavailable");

  const { data: existing } = await db.from("agent_messages").select("tool_trace").eq("session_id", sessionId);
  const done = new Set(((existing ?? []) as Row[]).map((r) => String((r.tool_trace as Row | null)?.copiedFrom ?? "")).filter(Boolean));
  const fresh = rows.filter((r) => !done.has(String(r.id)));
  if (fresh.length === 0) return 0;
  const { error } = await db.from("agent_messages").insert(
    fresh.map((r) => ({
      session_id: sessionId,
      landlord_id: input.newOwnerId,
      role: r.role === "assistant" ? "assistant" : "user",
      content: String(r.content ?? ""),
      channel: r.channel ?? "sms",
      tool_trace: { copiedFrom: String(r.id), source: "propline_line" },
      created_at: r.created_at,
    })),
  );
  if (error) throw new Error("carryover messages not written");
  return fresh.length;
}

async function copyInboxThread(
  db: SupabaseClient,
  input: { serviceOwnerId: string; phone: string; role: PropLaneLineRole; newOwnerId: string; newWorkspaceId: string | null },
): Promise<number> {
  const { data } = await db
    .from("manager_sms_messages")
    .select("id, direction, body, created_at, counterparty_role")
    .eq("manager_user_id", input.serviceOwnerId)
    .eq("resident_phone", input.phone)
    .in("counterparty_role", SOURCE_THREAD_ROLES[input.role])
    .order("created_at", { ascending: true })
    .limit(500);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return 0;

  const line = await propLaneLineNumber(db, input.serviceOwnerId);
  const otherEmail = `${line ?? "propline"}@sms.proplane.local`;
  let copied = 0;
  for (const row of rows) {
    const body = String(row.body ?? "").trim() || "(text)";
    const outbound = row.direction === "outbound";
    const stored = await deliverPortalMessageThreadSide(db, {
      scope: scopeForRole(input.role),
      folder: "inbox",
      ownerUserId: input.newOwnerId,
      participantEmail: otherEmail,
      otherPartyEmail: otherEmail,
      conversation: { ...(line ? { otherPartyPhone: line } : {}), ...(input.newWorkspaceId ? { workspaceId: input.newWorkspaceId } : {}) },
      fallbackId: `propline-copy-thread:${input.newOwnerId}:${input.role}`,
      fromName: "PropLane",
      subject: "PropLane chat",
      body,
      preview: body.slice(0, 100).replace(/\n/g, " "),
      when: formatPacificDateTime(new Date(String(row.created_at))),
      unread: false,
      outbound,
      messageId: `propline-copy:${input.newOwnerId}:${String(row.id)}`,
      channel: "sms",
      messageSubject: "PropLane chat",
    });
    if (stored.action !== "skipped") copied += 1;
  }
  return copied;
}

/**
 * The activation hook: the person's number just became ready, so bring their PropLane-line chat along. Reads the
 * VERIFIED phone from their own profile (the line's chat is keyed by it), never anything the caller typed. Never throws.
 */
export async function carryOverPropLaneLineHistory(
  db: SupabaseClient,
  userId: string,
  role: PropLaneLineRole,
): Promise<CopyHistoryResult> {
  try {
    const { data } = await db.from("profiles").select("phone, phone_verified_at").eq("id", userId).maybeSingle();
    const row = data as { phone?: unknown; phone_verified_at?: unknown } | null;
    const phone = normalizeE164(String(row?.phone ?? ""));
    if (!row?.phone_verified_at || !phone) return { ok: true, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "invalid_phone" };
    return await copyPropLaneLineHistory(db, { phoneE164: phone, role, newOwnerId: userId });
  } catch {
    return { ok: false, agentMessagesCopied: 0, inboxMessagesCopied: 0, reason: "failed" };
  }
}
