import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { normalizeE164 } from "@/lib/phone-e164";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { smsNoticeThreadId, type OriginalSmsNoticeEvent } from "@/lib/sms-inbox-notice.server";
import { SMS_COUNTERPARTY_ROLES, buildConversationKey } from "@/lib/sms-conversation-identity";
import { emailKey } from "@/lib/communication/conversation-key";
import {
  adoptThreadIntoConversation,
  conversationRowData,
  createKeyedThreadRow,
  findThreadByConversation,
} from "@/lib/communication/conversation-thread.server";
import type { ConversationRef } from "@/lib/communication/conversation-key.server";
import type {
  ProspectContextInput,
  RecordInboundInput,
  RecordInboundResult,
  RecordOutboundInput,
} from "@/lib/prospect-spine/contracts";
import { contextLabel, maskedPhoneLabel, sourceLabelFor } from "@/lib/prospect-spine/label";
import { loadHouse } from "@/lib/prospect-spine/context.server";
import { prospectPhoneRef } from "@/lib/prospect-spine/locate.server";
import {
  MANAGER_INBOX_SCOPE,
  isMissingSchema,
  mergeThreadRowData,
  readThread,
  threadHasMessage,
} from "@/lib/prospect-spine/thread.server";
import { recordDeliveryIssue } from "@/lib/prospect-spine/delivery-issue.server";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Extras only a server caller that already holds them passes (the leasing bot's original-SMS evidence, its own subject). */
export type RecordInboundExtras = {
  originalSmsEvent?: OriginalSmsNoticeEvent;
  subjectLabel?: string;
  /** The counterparty role the SMS projection tags this person under (`prospect` by default, `resident` for a resident). */
  counterpartyRole?: "prospect" | "resident";
  /** The stored thread type for a NEW row (`claw_leasing_sms` default; `claw_resident_sms` for a resident). An existing row keeps its own. */
  threadType?: "claw_leasing_sms" | "claw_resident_sms";
};

/** A platform handle's stable thread key: a synthetic mail key, so the existing email key kind carries it. */
function handleRef(workspaceId: string, contactHandle: string): ConversationRef {
  const key = emailKey(`${contactHandle}@lead.proplane.invalid`);
  return { workspaceId, key, keys: [key], flagged: null };
}

function handleThreadId(ownerUserId: string, contactHandle: string): string {
  return `prospect_${createHash("sha256").update(`${ownerUserId}:${contactHandle}`).digest("hex").slice(0, 40)}`;
}

/** Add or bump one `sms_phone_contacts` row: the phone's claims (name, email) fill gaps only; `verified_at` only from a proof. */
async function upsertPhoneContact(
  db: SupabaseClient,
  input: { phoneE164: string; displayName?: string | null; email?: string | null; verified: boolean; source: string },
): Promise<void> {
  const email = str(input.email).toLowerCase();
  const name = str(input.displayName).slice(0, 80);
  const now = new Date().toISOString();
  const { data: existing, error } = await db
    .from("sms_phone_contacts")
    .select("phone_e164, display_name, email, verified_at, first_source")
    .eq("phone_e164", input.phoneE164)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return;
    throw error;
  }
  if (!existing) {
    const { error: insertError } = await db.from("sms_phone_contacts").insert({
      phone_e164: input.phoneE164,
      phone_key: phoneKeyOf(input.phoneE164),
      display_name: name || null,
      email: email.includes("@") ? email : null,
      verified_at: input.verified ? now : null,
      first_source: input.source,
      first_seen_at: now,
      last_seen_at: now,
    });
    if (!insertError || insertError.code === "23505") return;
    if (isMissingSchema(insertError)) return;
    throw insertError;
  }
  const row = existing as Row;
  const patch: Row = { last_seen_at: now };
  if (name && !str(row.display_name)) patch.display_name = name;
  if (email.includes("@") && !str(row.email)) patch.email = email;
  if (input.verified && !str(row.verified_at)) patch.verified_at = now;
  if (!str(row.first_source)) patch.first_source = input.source;
  await db.from("sms_phone_contacts").update(patch).eq("phone_e164", input.phoneE164);
}

/** Add or bump the person x workspace x property x room x source row. Returns its id; null when the table is not there yet. */
async function upsertContext(
  db: SupabaseClient,
  input: {
    phoneKey: string | null;
    contactHandle: string | null;
    workspaceId: string;
    propertyId: string | null;
    roomId: string | null;
    roomLabel: string | null;
    source: string;
    sourceRef: string | null;
    threadId: string;
    occurredAt: string;
    bump: boolean;
  },
): Promise<string | null> {
  const find = async () => {
    let q = db.from("prospect_contexts").select("id, message_count").eq("workspace_id", input.workspaceId).eq("source", input.source);
    q = input.phoneKey ? q.eq("phone_key", input.phoneKey) : q.is("phone_key", null);
    q = input.contactHandle ? q.eq("contact_handle", input.contactHandle) : q.is("contact_handle", null);
    q = input.propertyId ? q.eq("property_id", input.propertyId) : q.is("property_id", null);
    q = input.roomId ? q.eq("room_id", input.roomId) : q.is("room_id", null);
    return q.maybeSingle();
  };
  const bumpExisting = async (row: Row) => {
    const patch: Row = { thread_id: input.threadId, updated_at: new Date().toISOString() };
    if (input.bump) {
      patch.message_count = Number(row.message_count ?? 0) + 1;
      patch.last_message_at = input.occurredAt;
    }
    if (input.roomLabel) patch.room_label = input.roomLabel;
    if (input.sourceRef) patch.source_ref = input.sourceRef;
    await db.from("prospect_contexts").update(patch).eq("id", str(row.id));
    return str(row.id);
  };
  const first = await find();
  if (first.error) {
    if (isMissingSchema(first.error)) return null;
    throw first.error;
  }
  if (first.data) return bumpExisting(first.data as Row);
  const { data: inserted, error } = await db
    .from("prospect_contexts")
    .insert({
      phone_key: input.phoneKey,
      contact_handle: input.contactHandle,
      workspace_id: input.workspaceId,
      property_id: input.propertyId,
      room_id: input.roomId,
      room_label: input.roomLabel,
      source: input.source,
      source_ref: input.sourceRef,
      thread_id: input.threadId,
      first_message_at: input.occurredAt,
      last_message_at: input.occurredAt,
      message_count: input.bump ? 1 : 0,
    })
    .select("id")
    .maybeSingle();
  if (!error && inserted) return str((inserted as Row).id);
  if (error && error.code === "23505") {
    // Another writer created the same context between our read and write: bump theirs.
    const again = await find();
    if (again.data) return bumpExisting(again.data as Row);
  }
  if (isMissingSchema(error)) return null;
  throw error ?? new Error("prospect context not written");
}

type EnsuredThread = { threadId: string; created: boolean; ref: ConversationRef };

/**
 * The ONE thread for this person in this workspace. Order: the keyed row (any id), else the legacy `sms_notice_*` row on
 * the deterministic id (adopted onto the key, never duplicated), else a new row through the database function (a lock on
 * owner + workspace, so two racing writers cannot mint two). Never a bare upsert.
 */
async function ensureThread(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string;
    phoneE164: string | null;
    contactHandle: string | null;
    rootRow: Row;
    threadType: string;
  },
): Promise<EnsuredThread> {
  const ref = input.phoneE164
    ? await prospectPhoneRef(db, { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId, phoneE164: input.phoneE164 })
    : handleRef(input.workspaceId, input.contactHandle!);
  const side = { scope: MANAGER_INBOX_SCOPE, ownerUserId: input.ownerUserId, participantEmail: null };
  const existing = await findThreadByConversation(db, side, ref);
  if (existing) return { threadId: existing.id, created: false, ref };

  const id = input.phoneE164 ? smsNoticeThreadId(input.ownerUserId, input.phoneE164) : handleThreadId(input.ownerUserId, input.contactHandle!);
  // A notice written by the old path sits under the deterministic id with no key column: adopt it, keep its turns.
  const legacy = await readThread(db, id);
  if (legacy && legacy.ownerUserId === input.ownerUserId) {
    await adoptThreadIntoConversation(db, id, ref).catch(() => false);
    return { threadId: id, created: false, ref };
  }
  const created = await createKeyedThreadRow(db, ref, {
    id,
    scope: MANAGER_INBOX_SCOPE,
    ownerUserId: input.ownerUserId,
    participantEmail: null,
    threadType: input.threadType,
    rowData: { ...input.rootRow, id },
  });
  if (created.error) throw new Error("Could not create the conversation.");
  return { threadId: created.id, created: created.created, ref };
}

const clean = (v: string | null | undefined): string | null => (str(v) ? str(v) : null);

async function loadWorkspace(db: SupabaseClient, workspaceId: string): Promise<{ ownerUserId: string } | null> {
  const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  const owner = str((data as Row | null)?.owner_user_id);
  return owner ? { ownerUserId: owner } : null;
}

/**
 * The single writer of a prospect's turn (design-1112 3.0). Every inbound text, listing message and platform inquiry
 * lands here; staff see one conversation per person per workspace, tagged with the house and room.
 */
export async function recordInboundWithExtras(
  db: SupabaseClient,
  input: RecordInboundInput,
  extras: RecordInboundExtras = {},
): Promise<RecordInboundResult> {
  const workspaceId = str(input.workspaceId);
  const ownerUserId = str(input.ownerUserId);
  const identity = input.identity;
  const phoneE164 = identity.kind === "phone" ? normalizeE164(identity.phoneE164) : null;
  const contactHandle = identity.kind === "handle" ? str(identity.contactHandle) : null;
  if (!workspaceId || !ownerUserId || input.body == null || !str(input.eventId)) return { ok: false, reason: "invalid_identity" };
  if (identity.kind === "phone" ? !phoneE164 : !contactHandle) return { ok: false, reason: "invalid_identity" };

  let threadIdForIssue: string | null = null;
  try {
    const workspace = await loadWorkspace(db, workspaceId);
    // The owner is re-derived from the workspace row: a caller's owner id is a name, never a grant.
    if (!workspace || workspace.ownerUserId !== ownerUserId) return { ok: false, reason: "workspace_not_found" };

    // Context: a property that is not this workspace's is dropped, never tagged; an unknown room keeps only its label.
    const requested = input.context;
    const house = await loadHouse(db, requested.propertyId);
    const houseOk = house && house.ownerUserId === ownerUserId && (!house.workspaceId || house.workspaceId === workspaceId) ? house : null;
    const room = houseOk && requested.roomId ? houseOk.rooms.find((r) => r.id === requested.roomId) ?? null : null;
    const propertyId = houseOk?.id ?? null;
    const roomId = room?.id ?? null;
    const roomLabel = room?.label ?? clean(requested.roomLabel);
    const source = requested.source;
    const sourceLabel = sourceLabelFor(source);
    const tag = contextLabel({ propertyLabel: houseOk?.label || null, roomLabel: propertyId ? roomLabel : null, sourceLabel });
    const fromLabel = identity.kind === "phone"
      ? (str(identity.displayName) || phoneE164!)
      : (str(identity.displayName) || "Lead");
    const label = tag || (phoneE164 ? maskedPhoneLabel(phoneE164) : fromLabel);

    if (phoneE164) {
      await upsertPhoneContact(db, {
        phoneE164,
        displayName: identity.kind === "phone" ? identity.displayName : null,
        email: identity.kind === "phone" ? identity.email : null,
        verified: identity.kind === "phone" && identity.verified,
        source,
      }).catch((e) => console.error("prospect phone contact not written", e instanceof Error ? e.message : "unknown"));
    }

    const at = Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt) : new Date();
    const stamp = formatInboxStamp(at);
    const messageId = input.channel === "sms" && !input.eventId.startsWith("web:")
      ? `leasing_${input.eventId}`
      : `prospect_${input.eventId}`;
    const body = input.body || "(empty message)";
    const channel = input.channel;
    const subjectLabel = extras.subjectLabel ?? (channel === "sms" ? "Text" : "Message");
    const subject = `(${subjectLabel}${tag ? ` — ${tag}` : ""}) ${fromLabel}`;
    const phoneKey = phoneE164 ? phoneKeyOf(phoneE164) : null;
    const phoneThreadType = extras.threadType ?? "claw_leasing_sms";
    const prospectContext = {
      propertyId, propertyLabel: houseOk?.label || null, roomId, roomLabel, source, sourceLabel, label, at: at.toISOString(),
    };
    const incoming: Row = {
      folder: "inbox", from: fromLabel, email: "", subject,
      preview: body.slice(0, 100).replace(/\n/g, " "), body,
      rootAt: stamp, time: stamp, unread: true,
      scope: MANAGER_INBOX_SCOPE, ownerUserId,
      threadType: phoneE164 ? phoneThreadType : "prospect_inquiry",
      ...(phoneE164 ? { smsNoticePhone: phoneE164 } : {}),
      rootMessageId: messageId, rootOutbound: false, rootChannel: channel,
      ...(propertyId ? { rootHouseId: propertyId } : {}),
      ...(roomId ? { rootRoomId: roomId } : {}),
      ...(extras.originalSmsEvent ? { rootOriginalSmsEvent: extras.originalSmsEvent } : {}),
      ...(phoneKey ? { prospectPhoneKey: phoneKey } : {}),
      prospectContext,
      workspaceId,
    };

    const ensured = await ensureThread(db, {
      ownerUserId, workspaceId, phoneE164, contactHandle,
      rootRow: incoming,
      threadType: phoneE164 ? phoneThreadType : "prospect_inquiry",
    });
    const threadId = ensured.threadId;
    threadIdForIssue = threadId;
    // The id lives in the row too (the append function checks it); a created row's id is only known now.
    incoming.id = threadId;
    Object.assign(incoming, conversationRowData(ensured.ref));

    const snapshot = await readThread(db, threadId);
    // A row this call just created holds the turn as its root: that is the write, not a replay.
    const duplicate = !ensured.created && snapshot ? threadHasMessage(snapshot.rowData, messageId) : false;

    // A later turn that names no house never downgrades the thread's context: the house, room and label it already holds
    // stay (never null, never a masked phone). A turn that DOES name a house adds that context (its own prospect_contexts
    // row) and becomes the thread's latest.
    const held = !ensured.created && snapshot && snapshot.rowData.prospectContext && typeof snapshot.rowData.prospectContext === "object"
      ? (snapshot.rowData.prospectContext as Row)
      : null;
    const keepHeld = !propertyId && held !== null && Boolean(str(held.propertyId));
    const ctxPropertyId = keepHeld ? str(held!.propertyId) : propertyId;
    const ctxRoomId = keepHeld ? str(held!.roomId) || null : roomId;
    const ctxRoomLabel = keepHeld ? str(held!.roomLabel) || null : roomLabel;
    const ctxTag = keepHeld ? str(held!.label) || tag : tag;
    const ctxPropertyLabel = keepHeld ? str(held!.propertyLabel) || null : houseOk?.label || null;
    const ctxLabel = keepHeld ? ctxTag : label;
    const latestContext = keepHeld
      ? { ...prospectContext, propertyId: ctxPropertyId, propertyLabel: ctxPropertyLabel, roomId: ctxRoomId, roomLabel: ctxRoomLabel, label: ctxLabel }
      : prospectContext;

    const contextId = await upsertContext(db, {
      phoneKey, contactHandle, workspaceId, propertyId: ctxPropertyId, roomId: ctxRoomId, roomLabel: ctxRoomLabel, source,
      sourceRef: clean(requested.sourceRef), threadId, occurredAt: at.toISOString(), bump: !duplicate,
    }).catch((e) => {
      console.error("prospect context not written", e instanceof Error ? e.message : "unknown");
      return null;
    });

    if (!duplicate) {
      const controlKeys = phoneE164
        ? SMS_COUNTERPARTY_ROLES.map((role) => buildConversationKey({ ownerManagerUserId: ownerUserId, role, counterpartyPhone: phoneE164 }))
        : [];
      const turn: Row = {
        id: messageId, from: fromLabel, body, at: stamp, outbound: false, channel,
        ...(ctxPropertyId ? { houseId: ctxPropertyId } : {}),
        ...(ctxRoomId ? { roomId: ctxRoomId } : {}),
        ...(ctxRoomLabel ? { roomLabel: ctxRoomLabel } : {}),
        source,
        ...(extras.originalSmsEvent ? { originalSmsEvent: extras.originalSmsEvent } : {}),
      };
      const { data, error } = await db.rpc("append_manager_sms_inbox_notice", {
        p_owner: ownerUserId,
        p_thread_id: threadId,
        p_thread_type: phoneE164 ? phoneThreadType : "prospect_inquiry",
        p_message_id: messageId,
        p_incoming: incoming,
        p_message: turn,
        p_inbound: true,
        p_control_keys: controlKeys,
      });
      if (error || !data || (data as Row).threadId !== threadId || (data as Row).messageId !== messageId) {
        throw new Error("Could not append the inbound turn.");
      }
      // The row-level stamps: newest context, the person's key. One atomic merge, never a read-modify-write of the turns.
      await mergeThreadRowData(db, {
        threadId, ownerUserId,
        patch: { prospectContext: latestContext, ...(phoneKey ? { prospectPhoneKey: phoneKey } : {}), workspaceId },
      });
    }

    if (ctxPropertyId && phoneE164 && !duplicate) {
      const { tagConversationHouse } = await import("@/lib/sms/conversation-houses.server");
      const role = extras.counterpartyRole ?? "prospect";
      await tagConversationHouse(db, {
        managerUserId: ownerUserId,
        conversationKey: buildConversationKey({ ownerManagerUserId: ownerUserId, role, counterpartyUserId: null, counterpartyPhone: phoneE164 }),
        propertyId: ctxPropertyId,
        source: role === "resident" ? "residency" : "leasing",
      }).catch(() => false);
    }

    if (!duplicate && input.channel === "sms" && phoneE164 && !input.eventId.startsWith("web:") && (input.media?.length ?? 0) > 0) {
      const { linkSmsMediaToRecord } = await import("@/lib/one-number/inbound-media.server");
      await linkSmsMediaToRecord(db, { messageSid: input.eventId, linkedType: "lead", linkedId: threadId }).catch(() => undefined);
    }

    if (!duplicate && input.notify !== false) {
      try {
        const { alertOpsOfInboundText } = await import("@/lib/one-number/inbound-alert.server");
        await alertOpsOfInboundText(db, {
          workspaceId, managerId: ownerUserId,
          fromPhone: phoneE164 ?? "",
          senderName: phoneE164 ? null : fromLabel,
          body, messageSid: input.eventId,
          onPropLaneLine: false,
          propertyId: ctxPropertyId, houseLabel: ctxTag || null,
          channelLabel: channel === "sms" ? null : (sourceLabel ?? (channel === "email" ? "Email" : "Message")),
          threadId,
        });
      } catch {
        /* an alert never fails the write that precedes it */
      }
    }

    return { ok: true, threadId, messageId, contextId: contextId ?? "", created: ensured.created, duplicate, label: ctxLabel };
  } catch (error) {
    console.error("prospect spine inbound failed", error instanceof Error ? error.message : "unknown");
    await recordDeliveryIssue(db, {
      threadId: threadIdForIssue,
      workspaceId: workspaceId || null,
      direction: "inbound",
      reason: "A message arrived but could not be saved to the inbox. PropLane will retry it.",
      eventId: input.eventId,
    });
    return { ok: false, reason: "store_unavailable" };
  }
}

export async function recordInbound(db: SupabaseClient, input: RecordInboundInput): Promise<RecordInboundResult> {
  return recordInboundWithExtras(db, input);
}

/**
 * Record a turn PropLane (or a staff member) SENT onto the person's thread. Append-only, idempotent on `eventId`, and it
 * never creates a thread: an outbound with nothing to answer under is `ok: false`. `automated` / `assistant` authors read
 * as the Assistant's side; a staff author carries their own name and account id.
 */
export async function recordOutbound(db: SupabaseClient, input: RecordOutboundInput): Promise<{ ok: boolean; messageId?: string }> {
  try {
    const ownerUserId = str(input.ownerUserId);
    const threadId = str(input.threadId);
    const body = str(input.body);
    if (!ownerUserId || !threadId || !body || !str(input.eventId)) return { ok: false };
    const snapshot = await readThread(db, threadId);
    if (!snapshot || snapshot.ownerUserId !== ownerUserId) return { ok: false };
    if (snapshot.workspaceId && snapshot.workspaceId !== str(input.workspaceId)) return { ok: false };
    const messageId = `out_${createHash("sha256").update(`${threadId}:${input.eventId}`).digest("hex").slice(0, 32)}`;
    if (threadHasMessage(snapshot.rowData, messageId)) return { ok: true, messageId };
    const { SMS_AUTO_REPLY_AUTHOR } = await import("@/lib/sms-auto-reply");
    const author = input.author;
    const from = author.kind === "staff" ? (str(author.name) || "PropLane team") : author.kind === "assistant" ? SMS_AUTO_REPLY_AUTHOR : (str(author.label) || SMS_AUTO_REPLY_AUTHOR);
    const stamp = formatInboxStamp(new Date());
    const house = input.context?.propertyId ? await loadHouse(db, input.context.propertyId) : null;
    const houseId = house && house.ownerUserId === ownerUserId ? house.id : null;
    const phone = str(snapshot.rowData.smsNoticePhone);
    const incoming: Row = {
      id: threadId, folder: "sent", from, email: "", subject: "Reply", preview: body.slice(0, 100).replace(/\n/g, " "), body,
      rootAt: stamp, time: stamp, unread: false, scope: MANAGER_INBOX_SCOPE, ownerUserId,
      threadType: str(snapshot.rowData.threadType) || "claw_leasing_sms", rootMessageId: messageId, rootOutbound: true, rootChannel: input.channel,
    };
    const { data, error } = await db.rpc("append_manager_sms_inbox_notice", {
      p_owner: ownerUserId,
      p_thread_id: threadId,
      p_thread_type: str(snapshot.rowData.threadType) || "claw_leasing_sms",
      p_message_id: messageId,
      p_incoming: incoming,
      p_message: {
        id: messageId, from, body, at: stamp, outbound: true, channel: input.channel,
        ...(author.kind === "staff" ? { authorUserId: author.userId } : { automated: true }),
        ...(houseId ? { houseId } : {}),
        ...(input.context?.roomId ? { roomId: input.context.roomId } : {}),
        ...(input.context?.roomLabel ? { roomLabel: input.context.roomLabel } : {}),
      },
      p_inbound: false,
      p_control_keys: phone ? SMS_COUNTERPARTY_ROLES.map((role) => buildConversationKey({ ownerManagerUserId: ownerUserId, role, counterpartyPhone: phone })) : [],
    });
    if (error || !data) return { ok: false };
    return { ok: true, messageId };
  } catch {
    return { ok: false };
  }
}

export type { ProspectContextInput };
