import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import { resolveSmsConversationRef } from "@/lib/communication/conversation-key.server";
import { workspaceKey } from "@/lib/communication/conversation-key";
import { adoptThreadIntoConversation, createKeyedThreadRow, findThreadByConversation } from "@/lib/communication/conversation-thread.server";
import { RESIDENT_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { MANAGER_INBOX_SCOPE, isMissingSchema, mergeThreadRowData, readThread } from "@/lib/prospect-spine/thread.server";
import { prospectPhoneRef } from "@/lib/prospect-spine/locate.server";
import type { ProspectRecordView, ProspectSource } from "@/lib/prospect-spine/contracts";
import { loadHouse } from "@/lib/prospect-spine/context.server";
import { smsNoticeThreadId } from "@/lib/sms-inbox-notice.server";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/**
 * Is `phoneE164` PROVEN to belong to `userId`, and to nobody else? The trust anchor for every link and merge: a profile
 * whose `phone_verified_at` is set for exactly this number, and `phone_auth_owners` naming that one account. A typed
 * phone, an unverified profile, or a number two accounts hold is never enough.
 */
export async function phoneProvenFor(db: SupabaseClient, userId: string, phoneE164: string): Promise<boolean> {
  const phone = normalizeE164(phoneE164);
  if (!phone || !userId) return false;
  try {
    const { data: profile, error } = await db.from("profiles").select("id, phone, phone_verified_at").eq("id", userId).maybeSingle();
    if (error || !profile) return false;
    const row = profile as Row;
    if (!str(row.phone_verified_at) || normalizeE164(str(row.phone)) !== phone) return false;
    const { phoneOwners } = await import("@/lib/auth/phone-auth.server");
    const owners = await phoneOwners(db, phone);
    return owners.length === 1 && owners[0] === userId;
  } catch {
    return false;
  }
}

/** Every turn of a manager-side thread as the PERSON sees it: their own texts are "outbound" to them. Pure. */
export function residentViewOfTurns(rowData: Row): Row[] {
  const messages = Array.isArray(rowData.messages) ? (rowData.messages as Row[]) : [];
  const rootId = str(rowData.rootMessageId);
  const turns: Row[] = [];
  if (rootId) {
    turns.push({
      id: rootId, from: str(rowData.from), body: str(rowData.body), at: str(rowData.rootAt) || str(rowData.time),
      outbound: rowData.rootOutbound !== true, channel: str(rowData.rootChannel) || "sms",
      ...(str(rowData.rootHouseId) ? { houseId: str(rowData.rootHouseId) } : {}),
    });
  }
  for (const turn of messages) {
    const id = str(turn.id);
    if (!id) continue;
    turns.push({
      id, from: str(turn.from), body: str(turn.body), at: str(turn.at), outbound: turn.outbound !== true,
      channel: str(turn.channel) || "sms",
      ...(str(turn.houseId) ? { houseId: str(turn.houseId) } : {}),
      ...(str(turn.roomLabel) ? { roomLabel: str(turn.roomLabel) } : {}),
    });
  }
  return turns;
}

/**
 * The account side of a linked conversation: one resident-scope thread, per workspace, holding the earlier text history
 * (same conversation key family as the manager side: `ws:<workspace>`). Idempotent: the id is deterministic and a re-run
 * only adds turns it does not hold.
 */
async function mirrorToAccount(
  db: SupabaseClient,
  input: { userId: string; workspaceId: string; managerThreadId: string; managerRowData: Row; label: string },
): Promise<boolean> {
  const turns = residentViewOfTurns(input.managerRowData);
  if (turns.length === 0) return false;
  const id = `prospect_link_${createHash("sha256").update(`${input.userId}:${input.workspaceId}`).digest("hex").slice(0, 40)}`;
  const key = workspaceKey(input.workspaceId);
  const ref = { workspaceId: input.workspaceId, key, keys: [key], flagged: null };
  const last = turns[turns.length - 1]!;
  const row: Row = {
    id, folder: "inbox", from: str(input.managerRowData.from) || "PropLane", email: "",
    subject: input.label ? `About ${input.label}` : "Your earlier texts", preview: str(last.body).slice(0, 100).replace(/\n/g, " "),
    body: str(turns[0]!.body), rootAt: str(turns[0]!.at), time: str(last.at), unread: false,
    scope: RESIDENT_INBOX_SCOPE, ownerUserId: input.userId, threadType: "portal_message",
    rootMessageId: str(turns[0]!.id), rootOutbound: turns[0]!.outbound === true, rootChannel: str(turns[0]!.channel) || "sms",
    messages: turns.slice(1), linkedFromThreadId: input.managerThreadId, prospectContext: input.managerRowData.prospectContext ?? null,
  };
  const created = await createKeyedThreadRow(db, ref, {
    id, scope: RESIDENT_INBOX_SCOPE, ownerUserId: input.userId, participantEmail: null, threadType: "portal_message", rowData: row,
  });
  if (created.error) return false;
  if (!created.created) {
    // Already mirrored once: add only the turns it does not hold yet.
    const existing = await readThread(db, created.id);
    if (!existing) return false;
    const held = new Set<string>([str(existing.rowData.rootMessageId), ...((Array.isArray(existing.rowData.messages) ? existing.rowData.messages : []) as Row[]).map((m) => str(m.id))]);
    const fresh = turns.filter((t) => !held.has(str(t.id)));
    if (fresh.length === 0) return true;
    const merged = [...((Array.isArray(existing.rowData.messages) ? existing.rowData.messages : []) as Row[]), ...fresh];
    await mergeThreadRowData(db, {
      threadId: created.id, ownerUserId: input.userId,
      patch: { messages: merged, time: str(last.at), preview: str(last.body).slice(0, 100).replace(/\n/g, " ") },
    });
  }
  return true;
}

/** Stamp `residentUserId` on an application or tour row for this phone, only when it has none (never moves an owned row). */
async function stampOwnedRows(db: SupabaseClient, input: { userId: string; phoneE164: string; ownerUserIds: string[] }): Promise<void> {
  if (input.ownerUserIds.length === 0) return;
  try {
    const { data } = await db
      .from("manager_application_records")
      .select("id, row_data")
      .in("manager_user_id", input.ownerUserIds)
      .limit(500);
    for (const row of (data ?? []) as Row[]) {
      const rd = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Row;
      if (str(rd.residentUserId)) continue;
      if (normalizeE164(str(rd.phone)) !== input.phoneE164) continue;
      await db.from("manager_application_records").update({ row_data: { ...rd, residentUserId: input.userId } }).eq("id", str(row.id));
    }
  } catch {
    /* advisory: the conversation link above does not depend on it */
  }
}

/**
 * Link a freshly VERIFIED account to the prospect record on its phone (design-1112 2.4). Idempotent, and a no-op unless the
 * phone is proven for exactly this account. Never matches on name or email. Never throws.
 */
export async function linkAccountToProspectRecord(
  db: SupabaseClient,
  input: { userId: string; phoneE164: string },
): Promise<{ linked: boolean; threads: number }> {
  const none = { linked: false, threads: 0 };
  try {
    const phone = normalizeE164(input.phoneE164);
    if (!phone || !input.userId) return none;
    if (!(await phoneProvenFor(db, input.userId, phone))) return none;

    const now = new Date().toISOString();
    const { data: existing, error } = await db.from("sms_phone_contacts").select("phone_e164, user_id, verified_at, linked_at").eq("phone_e164", phone).maybeSingle();
    if (error && !isMissingSchema(error)) return none;
    const contact = (existing ?? null) as Row | null;
    // A record already linked to a DIFFERENT account is never re-pointed by a later verification.
    if (contact && str(contact.user_id) && str(contact.user_id) !== input.userId) return none;
    if (contact) {
      await db.from("sms_phone_contacts").update({
        user_id: input.userId,
        verified_at: str(contact.verified_at) || now,
        linked_at: str(contact.linked_at) || now,
        last_seen_at: now,
      }).eq("phone_e164", phone);
    } else {
      await db.from("sms_phone_contacts").insert({
        phone_e164: phone, phone_key: phoneKeyOf(phone), user_id: input.userId, verified_at: now, linked_at: now, first_source: "in_app",
      });
    }

    const { data: contexts, error: contextError } = await db
      .from("prospect_contexts")
      .select("workspace_id, thread_id, property_id")
      .eq("phone_key", phoneKeyOf(phone));
    if (contextError) return { linked: true, threads: 0 };
    const byWorkspace = new Map<string, { threadId: string | null; propertyId: string | null }>();
    for (const c of (contexts ?? []) as Row[]) {
      const ws = str(c.workspace_id);
      if (!ws) continue;
      const current = byWorkspace.get(ws);
      byWorkspace.set(ws, { threadId: current?.threadId || str(c.thread_id) || null, propertyId: current?.propertyId || str(c.property_id) || null });
    }

    let threads = 0;
    const owners: string[] = [];
    for (const [workspaceId, ctx] of byWorkspace) {
      const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
      const ownerUserId = str((ws as Row | null)?.owner_user_id);
      if (!ownerUserId) continue;
      owners.push(ownerUserId);
      // The manager side: the account's own conversation ref (account key when the account is tied to this workspace, else the
      // verified phone key). Adoption keeps ONE manager-side thread; it never copies.
      const phoneRef = await prospectPhoneRef(db, { ownerUserId, workspaceId, phoneE164: phone });
      const thread = await findThreadByConversation(db, { scope: MANAGER_INBOX_SCOPE, ownerUserId, participantEmail: null }, phoneRef);
      const threadId = thread?.id ?? ctx.threadId ?? smsNoticeThreadId(ownerUserId, phone);
      const stored = thread ?? (await readThread(db, threadId).then((t) => (t ? { id: t.id, rowData: t.rowData } : null)));
      if (!stored) continue;
      const accountRef = await resolveSmsConversationRef(db, {
        ownerManagerUserId: ownerUserId, workspaceId, counterpartyUserId: input.userId, counterpartyPhone: phone,
      }).catch(() => null);
      if (accountRef && accountRef.key !== phoneRef.key && accountRef.key.startsWith("acct:")) {
        await adoptThreadIntoConversation(db, stored.id, accountRef).catch(() => false);
      }
      const house = ctx.propertyId ? await loadHouse(db, ctx.propertyId) : null;
      const prospectContext = (stored.rowData.prospectContext ?? null) as Row | null;
      const label = str(prospectContext?.label) || house?.label || "";
      const mirrored = await mirrorToAccount(db, { userId: input.userId, workspaceId, managerThreadId: stored.id, managerRowData: stored.rowData, label });
      if (mirrored) threads += 1;
    }
    await stampOwnedRows(db, { userId: input.userId, phoneE164: phone, ownerUserIds: owners });
    return { linked: true, threads };
  } catch (error) {
    console.error("prospect link failed", error instanceof Error ? error.message : "unknown");
    return none;
  }
}

/** One person's record: the phone's row plus every context, with house labels. Null when nothing is on file. */
export async function loadProspectRecord(
  db: SupabaseClient,
  key: { phoneE164: string } | { userId: string },
): Promise<ProspectRecordView | null> {
  try {
    let contact: Row | null = null;
    if ("phoneE164" in key) {
      const phone = normalizeE164(key.phoneE164);
      if (!phone) return null;
      const { data } = await db.from("sms_phone_contacts").select("phone_e164, user_id, display_name").eq("phone_e164", phone).maybeSingle();
      contact = (data ?? null) as Row | null;
      if (!contact) {
        const { data: ctx } = await db.from("prospect_contexts").select("id").eq("phone_key", phoneKeyOf(phone)).limit(1);
        if (!ctx || ctx.length === 0) return null;
        contact = { phone_e164: phone, user_id: null, display_name: null };
      }
    } else {
      const { data } = await db.from("sms_phone_contacts").select("phone_e164, user_id, display_name").eq("user_id", key.userId).limit(1);
      contact = ((data ?? [])[0] ?? null) as Row | null;
      if (!contact) return null;
    }
    const phone = str(contact.phone_e164);
    const { data: rows } = await db
      .from("prospect_contexts")
      .select("id, workspace_id, property_id, room_id, room_label, source, channel_state, thread_id, first_message_at, last_message_at, message_count")
      .eq("phone_key", phoneKeyOf(phone))
      .order("last_message_at", { ascending: false })
      .limit(200);
    const contexts: ProspectRecordView["contexts"] = [];
    const labels = new Map<string, string | null>();
    for (const r of (rows ?? []) as Row[]) {
      const propertyId = str(r.property_id) || null;
      if (propertyId && !labels.has(propertyId)) labels.set(propertyId, (await loadHouse(db, propertyId))?.label || null);
      contexts.push({
        id: str(r.id), workspaceId: str(r.workspace_id), propertyId, propertyLabel: propertyId ? labels.get(propertyId) ?? null : null,
        roomId: str(r.room_id) || null, roomLabel: str(r.room_label) || null, source: str(r.source) as ProspectSource,
        channelState: str(r.channel_state) === "moved" ? "moved" : "active", threadId: str(r.thread_id) || null,
        firstMessageAt: str(r.first_message_at), lastMessageAt: str(r.last_message_at), messageCount: Number(r.message_count ?? 0),
      });
    }
    return { phoneE164: phone || null, userId: str(contact.user_id) || null, displayName: str(contact.display_name) || null, contexts };
  } catch {
    return null;
  }
}
