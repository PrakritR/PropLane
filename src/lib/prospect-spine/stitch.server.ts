import "server-only";
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import { parseInboxStampMs } from "@/lib/portal-inbox-storage";
import { adoptThreadIntoConversation, findThreadByConversation } from "@/lib/communication/conversation-thread.server";
import type { ProspectSource, StitchResult } from "@/lib/prospect-spine/contracts";
import { prospectPhoneRef } from "@/lib/prospect-spine/locate.server";
import { MANAGER_INBOX_SCOPE, isMissingSchema, mergeThreadRowData, readThread } from "@/lib/prospect-spine/thread.server";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** No 0/O/1/I/L: a code a person reads off a screen and types into a text. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;

function newCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A platform inquiry's code to quote when texting the line. Returns the existing one when the context already has it. */
export async function mintStitchCode(db: SupabaseClient, contextId: string): Promise<string | null> {
  try {
    const id = str(contextId);
    if (!id) return null;
    const { data, error } = await db.from("prospect_contexts").select("id, stitch_code").eq("id", id).maybeSingle();
    if (error || !data) return null;
    const held = str((data as Row).stitch_code);
    if (held) return held;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = newCode();
      const { data: updated, error: updateError } = await db
        .from("prospect_contexts")
        .update({ stitch_code: code, updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("stitch_code", null)
        .select("stitch_code");
      if (!updateError && Array.isArray(updated) && updated.length > 0) return code;
      if (updateError && updateError.code !== "23505") return null;
      if (!updateError) {
        // Someone else minted one first.
        const again = await db.from("prospect_contexts").select("stitch_code").eq("id", id).maybeSingle();
        return str((again.data as Row | null)?.stitch_code) || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function turnsOf(rowData: Row): Row[] {
  const out: Row[] = [];
  const rootId = str(rowData.rootMessageId);
  if (rootId) {
    out.push({
      id: rootId, from: rowData.from, body: rowData.body, at: str(rowData.rootAt) || str(rowData.time),
      outbound: rowData.rootOutbound === true, channel: str(rowData.rootChannel) || "sms",
      ...(str(rowData.rootHouseId) ? { houseId: str(rowData.rootHouseId) } : {}),
    });
  }
  for (const m of (Array.isArray(rowData.messages) ? rowData.messages : []) as Row[]) if (str(m.id)) out.push(m);
  return out;
}

async function loadContext(db: SupabaseClient, by: { code: string; workspaceId: string } | { id: string }): Promise<Row | null> {
  const select = "id, workspace_id, phone_key, contact_handle, source, thread_id, property_id, room_id, stitch_code, channel_state";
  const query = "id" in by
    ? db.from("prospect_contexts").select(select).eq("id", by.id)
    : db.from("prospect_contexts").select(select).eq("stitch_code", by.code).eq("workspace_id", by.workspaceId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return (data ?? null) as Row | null;
}

/**
 * Merge a platform (handle) conversation into the phone-keyed one. ONE visible thread either way: the handle thread is adopted
 * onto the phone key when the phone has none yet, else its turns are folded into the phone thread and it is left as a pointer
 * (`mergedInto`, folder `trash`). The context turns MOVED. Matching is on the phone only, never a name or an email.
 */
async function stitchContext(db: SupabaseClient, context: Row, phoneE164: string, mode: { viaText: boolean }): Promise<StitchResult> {
  const phone = normalizeE164(phoneE164);
  if (!phone) return { ok: false, reason: "unknown_code" };
  const key = phoneKeyOf(phone);
  const currentPhoneKey = str(context.phone_key);
  if (!str(context.contact_handle) || (currentPhoneKey && currentPhoneKey !== key)) return { ok: false, reason: "ambiguous" };
  const workspaceId = str(context.workspace_id);
  const handleThreadId = str(context.thread_id);
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  const ownerUserId = str((ws as Row | null)?.owner_user_id);
  if (!ownerUserId) return { ok: false, reason: "store_unavailable" };
  const site = str(context.source) as ProspectSource;
  const movedAt = new Date().toISOString();

  const phoneRef = await prospectPhoneRef(db, { ownerUserId, workspaceId, phoneE164: phone });
  const side = { scope: MANAGER_INBOX_SCOPE, ownerUserId, participantEmail: null };
  let target = await findThreadByConversation(db, side, phoneRef);
  const handleThread = handleThreadId ? await readThread(db, handleThreadId) : null;
  if (handleThread && handleThread.ownerUserId !== ownerUserId) return { ok: false, reason: "ambiguous" };
  let threadId = target?.id ?? "";
  // MOVED only once the prospect is on the line: they texted (a quoted code), or the phone found in the platform message
  // already has an SMS thread of its own. A phone merely WRITTEN in an inquiry merges the thread but stays on the platform.
  const moved = mode.viaText || Boolean(target && target.id !== handleThreadId);

  if (!target && handleThread) {
    const adopted = await adoptThreadIntoConversation(db, handleThread.id, phoneRef);
    if (adopted) {
      threadId = handleThread.id;
    } else {
      target = await findThreadByConversation(db, side, phoneRef);
      threadId = target?.id ?? "";
    }
  }
  if (!threadId) return { ok: false, reason: "store_unavailable" };

  if (target && handleThread && handleThread.id !== target.id) {
    const held = turnsOf(target.rowData);
    const heldIds = new Set(held.map((t) => str(t.id)));
    const fresh = turnsOf(handleThread.rowData).filter((t) => !heldIds.has(str(t.id)));
    if (fresh.length > 0) {
      const rootId = str(target.rowData.rootMessageId);
      const merged = [...held, ...fresh]
        .filter((t) => str(t.id) !== rootId)
        .map((t, index) => ({ t, index, at: parseInboxStampMs(str(t.at)) }))
        .sort((a, b) => (a.at != null && b.at != null && a.at !== b.at ? a.at - b.at : a.index - b.index))
        .map((x) => x.t);
      await mergeThreadRowData(db, { threadId: target.id, ownerUserId, patch: { messages: merged } });
    }
    // The platform row stays as a pointer: nothing is deleted, and it never shows next to the person's own thread.
    await mergeThreadRowData(db, { threadId: handleThread.id, ownerUserId, patch: { mergedInto: target.id, folder: "trash" } });
  }

  await mergeThreadRowData(db, {
    threadId, ownerUserId,
    patch: {
      smsNoticePhone: phone,
      prospectPhoneKey: key,
      platformState: moved
        ? { site, state: "moved", movedAt, stitchCode: str(context.stitch_code) || null }
        : { site, state: "active", stitchCode: str(context.stitch_code) || null },
    },
  });

  // Every context of this handle in this workspace now belongs to the phone; the one that carried the code is MOVED.
  const handle = str(context.contact_handle);
  const { data: siblings } = await db
    .from("prospect_contexts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("contact_handle", handle);
  const ids = ((siblings ?? []) as Row[]).map((r) => str(r.id)).filter(Boolean);
  if (ids.length > 0) {
    await db
      .from("prospect_contexts")
      .update(moved
        ? { phone_key: key, channel_state: "moved", moved_at: movedAt, thread_id: threadId, updated_at: movedAt }
        : { phone_key: key, thread_id: threadId, updated_at: movedAt })
      .in("id", ids);
  }
  // The phone is a claim until a code proves it: a stitched record is NEVER verified here.
  const { data: contact } = await db.from("sms_phone_contacts").select("phone_e164").eq("phone_e164", phone).maybeSingle();
  if (!contact) {
    await db.from("sms_phone_contacts").insert({ phone_e164: phone, phone_key: key, first_source: site, verified_at: null });
  }
  return { ok: true, threadId, movedContextIds: moved ? ids : [], moved };
}

/** An inbound text quoting a platform inquiry's code merges the two conversations. Unknown code: nothing changes. */
export async function stitchByCode(db: SupabaseClient, input: { code: string; phoneE164: string; workspaceId: string }): Promise<StitchResult> {
  try {
    const code = str(input.code).toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return { ok: false, reason: "unknown_code" };
    const context = await loadContext(db, { code, workspaceId: str(input.workspaceId) });
    if (!context) return { ok: false, reason: "unknown_code" };
    return await stitchContext(db, context, input.phoneE164, { viaText: true });
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }
}

/** A phone found inside a platform message merges that thread under the phone key now (still unverified); it is MOVED only if that phone already has an SMS thread. */
export async function stitchByPhone(db: SupabaseClient, input: { contextId: string; phoneE164: string }): Promise<StitchResult> {
  try {
    const context = await loadContext(db, { id: str(input.contextId) });
    if (!context) return { ok: false, reason: "unknown_code" };
    return await stitchContext(db, context, input.phoneE164, { viaText: false });
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }
}

/**
 * A text arrived from a phone that a platform inquiry only CLAIMED (its thread merged under the phone key, still on the
 * platform): the prospect has now texted, so those contexts and their threads turn MOVED. Contexts already moved, and phones
 * no inquiry mentions, change nothing. Never throws.
 */
export async function moveClaimedContextsOnText(db: SupabaseClient, fromPhone: string): Promise<number> {
  try {
    const phone = normalizeE164(fromPhone);
    if (!phone) return 0;
    const key = phoneKeyOf(phone);
    const { data, error } = await db
      .from("prospect_contexts")
      .select("id, workspace_id, thread_id, source, stitch_code, contact_handle")
      .eq("phone_key", key)
      .eq("channel_state", "active")
      .not("contact_handle", "is", null)
      .limit(20);
    if (error || !data || data.length === 0) return 0;
    const rows = data as Row[];
    const movedAt = new Date().toISOString();
    await db.from("prospect_contexts").update({ channel_state: "moved", moved_at: movedAt, updated_at: movedAt }).in("id", rows.map((r) => str(r.id)));
    for (const row of rows) {
      const threadId = str(row.thread_id);
      if (!threadId) continue;
      const thread = await readThread(db, threadId);
      if (!thread?.ownerUserId) continue;
      await mergeThreadRowData(db, {
        threadId, ownerUserId: thread.ownerUserId,
        patch: { platformState: { site: str(row.source), state: "moved", movedAt, stitchCode: str(row.stitch_code) || null } },
      });
    }
    return rows.length;
  } catch {
    return 0;
  }
}

/** Per source: leads, still on the platform, moved to text, with an account. One leads row per person x property x room. */
export async function sourceReport(
  db: SupabaseClient,
  input: { workspaceId: string; propertyId?: string | null; since?: string | null },
): Promise<Array<{ source: ProspectSource; leads: number; onPlatform: number; movedToSms: number; withAccount: number }>> {
  try {
    let query = db
      .from("prospect_contexts")
      .select("source, phone_key, contact_handle, channel_state, property_id, room_id")
      .eq("workspace_id", input.workspaceId)
      .limit(5000);
    if (input.propertyId) query = query.eq("property_id", input.propertyId);
    if (input.since) query = query.gte("first_message_at", input.since);
    const { data, error } = await query;
    if (error) return [];
    const rows = (data ?? []) as Row[];
    const phoneKeys = [...new Set(rows.map((r) => str(r.phone_key)).filter(Boolean))];
    const withAccountKeys = new Set<string>();
    for (let at = 0; at < phoneKeys.length; at += 200) {
      const { data: contacts } = await db.from("sms_phone_contacts").select("phone_key, user_id").in("phone_key", phoneKeys.slice(at, at + 200)).not("user_id", "is", null);
      for (const c of (contacts ?? []) as Row[]) withAccountKeys.add(str(c.phone_key));
    }
    const bySource = new Map<string, { leads: Set<string>; onPlatform: Set<string>; moved: Set<string>; account: Set<string> }>();
    for (const r of rows) {
      const source = str(r.source);
      const person = str(r.phone_key) || `h:${str(r.contact_handle)}`;
      const entry = bySource.get(source) ?? { leads: new Set(), onPlatform: new Set(), moved: new Set(), account: new Set() };
      entry.leads.add(person);
      if (str(r.channel_state) === "moved") entry.moved.add(person);
      else if (str(r.contact_handle)) entry.onPlatform.add(person);
      if (str(r.phone_key) && withAccountKeys.has(str(r.phone_key))) entry.account.add(person);
      bySource.set(source, entry);
    }
    return [...bySource.entries()]
      .map(([source, e]) => ({ source: source as ProspectSource, leads: e.leads.size, onPlatform: e.onPlatform.size, movedToSms: e.moved.size, withAccount: e.account.size }))
      .sort((a, b) => b.leads - a.leads);
  } catch {
    return [];
  }
}
