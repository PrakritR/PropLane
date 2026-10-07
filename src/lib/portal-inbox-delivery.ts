import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";
import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboxThreadMessageChannel } from "@/lib/portal-inbox-storage";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import type { VendorNotificationTopic } from "@/lib/vendor-notification-settings";
import { filterRecipientsBySenderScope, recipientReachFromScope } from "@/lib/inbox-recipient-scope";
import { applyOwnerMessageInboxScope } from "@/lib/property-owner/access.server";
import { resolveAgentCommunicationScope } from "@/lib/communication/conversation-visibility.server";
import {
  ensureSmsIncludesPortalLink,
  type ResidentSmsLinkKind,
} from "@/lib/claw-resident-links";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { inboxDeepLinkForRole } from "@/lib/platform/parity";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders } from "@/lib/webhooks/events";
import { isManagerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";
// Pinned to Pacific, matching `formatInboxStamp` and every other inbox stamp
// writer. These stamps are persisted and later re-parsed for conversation
// ordering, but carry no timezone: this writer runs server-side (UTC on Vercel)
// while the client writer renders local, so the same instant was stored as two
// different stamps and a server-delivered message could outrank a later client
// reply by the UTC offset. A server-written stamp therefore now DISPLAYS shifted
// by that offset — that shift is the fix, not a regression.
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  resolveChannels,
  type NotificationCategory,
  type ResolvedChannels,
} from "@/lib/notification-preferences";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { ensureVendorConversationConsent } from "@/lib/sms/vendor-conversation-consent.server";
import { normalizeRecordRef, type RecordRef } from "@/lib/portals/record-kinds";
import { aggregateVendorSponsoredDelivery } from "@/lib/vendor-sponsored-delivery-state";
import {
  propertyLabelFor,
  resolveConversationRef,
  type ConversationHints,
  type ConversationRef,
} from "@/lib/communication/conversation-key.server";
import {
  adoptThreadIntoConversation,
  conversationRowData,
  conversationSchemaAvailable,
  createKeyedThreadRow,
  findThreadByConversation,
  resolveThreadAlias,
  upsertKeyedThreadRow,
} from "@/lib/communication/conversation-thread.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";

export type InboxDeliveryRecipient = {
  email: string;
  userId: string | null;
  role: string | null;
  scope: string;
};

export type InboxSmsConversationTarget = {
  conversationKey: string;
  counterpartyRole: SmsCounterpartyRole;
  /** Verified E.164 phone captured in the same authorization snapshot as the thread. */
  recipientPhone: string;
};

export type InboxSmsOutcome = {
  recipientEmail: string;
  status: "submitted" | "queued" | "deferred" | "unknown" | "failed" | "unavailable";
};

export type InboxEmailOutcome = {
  recipientEmail: string;
  status: "submitted" | "failed" | "skipped";
};

export function scopeForRole(role: string | null | undefined): string {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "manager" || normalized === "pro" || normalized === "admin") return MANAGER_INBOX_SCOPE;
  if (normalized === "vendor") return VENDOR_INBOX_SCOPE;
  return RESIDENT_INBOX_SCOPE;
}

type BroadcastRecipient = { email: string; userId: string | null; role: "resident" | "manager" };

export async function resolveBroadcastRecipients(
  db: SupabaseClient,
  senderId: string,
  categories: ("management" | "resident")[],
): Promise<BroadcastRecipient[]> {
  const out: BroadcastRecipient[] = [];

  async function approvedResidentsForManagers(managerIds: string[]) {
    if (managerIds.length === 0) return;
    const { data } = await db
      .from("manager_application_records")
      .select("resident_email, row_data")
      .in("manager_user_id", managerIds);
    for (const row of data ?? []) {
      const rowData = (row.row_data ?? {}) as Record<string, unknown>;
      if (rowData.bucket !== "approved") continue;
      const email = String(row.resident_email ?? rowData.email ?? "").trim().toLowerCase();
      if (email) out.push({ email, userId: null, role: "resident" });
    }
  }

  async function linkedCoManagersForManagers(managerIds: string[]) {
    if (managerIds.length === 0) return;
    const { data } = await db
      .from("portal_pro_relationship_records")
      .select("related_user_id, related_email")
      .in("manager_user_id", managerIds);
    for (const row of data ?? []) {
      const email = String(row.related_email ?? "").trim().toLowerCase();
      if (email) out.push({ email, userId: (row.related_user_id as string | null) ?? null, role: "manager" });
    }
  }

  if (categories.includes("resident")) await approvedResidentsForManagers([senderId]);
  if (categories.includes("management")) await linkedCoManagersForManagers([senderId]);
  return out;
}

/** A thread the sender is authorized to append to, resolved but not yet written. */
export type InboxThreadReplyTarget = {
  threadId: string;
  scope: string;
  ownerUserId: string | null;
  participantEmail: string | null;
  threadType: string;
  rowData: Record<string, unknown>;
};

/**
 * Resolve the thread a reply targets and authorize the sender against it: the
 * thread's owner, its participant (matched by email), or a co-manager with
 * Communication edit on that owner. Anything else resolves to `null` (a silent
 * no-op, mirroring the send-inbox-message route's historic behavior).
 *
 * READ-ONLY on purpose. Thread ownership is not the only gate a send has to
 * clear — the recipient-scope check in send-inbox-message can still refuse the
 * message with a 403 — so the write is split out into `commitInboxThreadReply`
 * and deferred until every gate has passed. Appending here is what let a
 * refused send land in the thread store (and become the conversation preview)
 * while the caller was told 403: the resident saw their message listed as sent
 * to a manager who never received it. Never merge the two back together.
 */
export async function resolveInboxThreadReplyTarget(
  db: SupabaseClient,
  opts: { threadId: string; senderUserId: string; senderEmail: string },
): Promise<InboxThreadReplyTarget | null> {
  let threadId = opts.threadId.trim();
  if (!threadId) return null;
  const senderEmail = opts.senderEmail.trim().toLowerCase();
  let { data: threadRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, participant_email, scope, thread_type")
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow) {
    // An old id that a folded conversation still answers to. The alias only
    // names the row; every ownership check below still applies to it.
    const aliased = await resolveThreadAlias(db, threadId);
    if (aliased && aliased !== threadId) {
      threadId = aliased;
      ({ data: threadRow } = await db
        .from("portal_inbox_thread_records")
        .select("id, row_data, owner_user_id, participant_email, scope, thread_type")
        .eq("id", threadId)
        .maybeSingle());
    }
  }
  if (!threadRow) return null;
  const ownerUserId = (threadRow.owner_user_id as string | null) ?? null;
  const isOwner = ownerUserId === opts.senderUserId;
  const managerScope = String(threadRow.scope ?? "") === MANAGER_INBOX_SCOPE;
  // Manager Communication: being the person a thread was sent to is not
  // access to it — that clause covers only legacy rows written with no owner.
  // The other owner never invited this manager (see conversation-visibility).
  const isParticipant =
    String(threadRow.participant_email ?? "").toLowerCase() === senderEmail && (!managerScope || !ownerUserId);
  let delegatedOwner = false;
  if (!isOwner && !isParticipant && ownerUserId && managerScope) {
    // A co-manager may reply only on a thread about a house they hold
    // Communication EDIT on — the same rule that lists it.
    try {
      const { visibleInboxThreadRecord } = await import("@/lib/communication/conversation-visibility.server");
      delegatedOwner =
        (await visibleInboxThreadRecord(db, opts.senderUserId, "edit", {
          id: threadId,
          owner_user_id: ownerUserId,
          participant_email: (threadRow.participant_email as string | null) ?? null,
          thread_type: (threadRow.thread_type as string | null) ?? null,
          row_data: threadRow.row_data,
        })) !== null;
    } catch {
      delegatedOwner = false;
    }
  }
  if (!isOwner && !isParticipant && !delegatedOwner) return null;
  const rowData = (threadRow.row_data ?? {}) as Record<string, unknown>;
  return {
    threadId,
    scope: String(threadRow.scope ?? rowData.scope ?? MANAGER_INBOX_SCOPE),
    ownerUserId: (threadRow.owner_user_id as string | null) ?? null,
    participantEmail: (threadRow.participant_email as string | null) ?? null,
    // Older notifications stamped their event type onto the one canonical
    // assistant thread. Resolve that owner-bound identity without requiring a
    // production data rewrite; a human conversation's name is never a signal.
    threadType: ownerUserId && isManagerAgentNoticeThreadId(threadId, ownerUserId) &&
      threadRow.scope === MANAGER_INBOX_SCOPE
      ? "agent_notice"
      : String(threadRow.thread_type ?? ""),
    rowData,
  };
}

/**
 * Write the reply onto an already-authorized thread. Call only once the send is
 * cleared.
 *
 * The authorization decision stays on `target`, but the body is merged onto a
 * FRESH read of `row_data`: the gates between resolve and commit are several DB
 * round trips wide, and an inbound `deliverPortalMessageThreadSide` (or a
 * concurrent reply) landing in that window would otherwise be dropped by this
 * last-write-wins upsert. A thread deleted in the same window is left deleted —
 * the upsert must not resurrect it.
 */
export async function commitInboxThreadReply(
  db: SupabaseClient,
  target: InboxThreadReplyTarget,
  opts: {
    fromName: string;
    text: string;
    attachments?: { url: string; name?: string }[];
    /** When set, stamps direction on the appended turn for assistant-thread rendering. */
    outbound?: boolean;
    messageId?: string;
    /** Channel the turn actually went on; omitted = unknown (never assumed email). */
    channel?: InboxThreadMessageChannel;
    /** Durable external-delivery state; never infer Sent before the provider records it. */
    delivery?: "sending" | "sent" | "failed";
    /** Email subject the turn left with, for the bubble's subject line. */
    subject?: string;
    /**
     * Stamp this thread as being about a record — but ONLY when it does not
     * already carry a `recordRef`. A reply into an already-classified thread
     * (e.g. a resident replying inside their Lease page's Communication) must
     * never relabel it onto whatever record the REPLIER happened to be
     * viewing; the ref is set once, by whoever first composed from a record.
     */
    recordRef?: RecordRef;
    /** The house this turn is about; each turn of a person's conversation carries its own. */
    houseId?: string;
    houseLabel?: string;
  },
): Promise<"sending" | "sent" | "failed" | undefined> {
  const { data: freshRow, error: readError } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data")
    .eq("id", target.threadId)
    .maybeSingle();
  if (readError) throw new Error("Could not load the conversation. Please try again.", { cause: readError });
  if (!freshRow) throw new Error("This conversation is no longer available.");
  const rowData = (freshRow.row_data ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as unknown[])] : [];
  // A durable outbound sender may be replayed after its provider accepted the
  // request.  Keep the thread append idempotent so a retry repairs a failed
  // companion write without showing the recipient a second sent turn.
  const existingIndex = opts.messageId
    ? messages.findIndex((message) => (message as { id?: unknown } | null)?.id === opts.messageId)
    : -1;
  if (existingIndex >= 0) {
    const existing = messages[existingIndex] as Record<string, unknown>;
    const prior = typeof existing.delivery === "string" ? existing.delivery : undefined;
    const delivery = opts.delivery
      ? aggregateVendorSponsoredDelivery([opts.delivery], prior as "sending" | "sent" | "failed" | undefined)
      : prior as "sending" | "sent" | "failed" | undefined;
    if (!opts.delivery || prior === delivery) return delivery;
    messages[existingIndex] = { ...existing, delivery };
    const { error } = await db.from("portal_inbox_thread_records").upsert({
      id: target.threadId, scope: target.scope, owner_user_id: target.ownerUserId,
      participant_email: target.participantEmail, row_data: { ...rowData, messages }, updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (error) throw new Error("Could not save the reply. Please try again.", { cause: error });
    return delivery;
  }
  const when = formatPacificDateTime(new Date());
  messages.push({
    id: opts.messageId ?? `reply-${Date.now().toString(36)}`,
    from: opts.fromName,
    body: opts.text,
    at: when,
    ...(opts.outbound !== undefined ? { outbound: opts.outbound } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
    ...(opts.subject?.trim() ? { subject: opts.subject.trim() } : {}),
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
    ...(opts.houseId?.trim() ? { houseId: opts.houseId.trim() } : {}),
    ...(opts.houseLabel?.trim() ? { houseLabel: opts.houseLabel.trim() } : {}),
  });
  const existingRecordRef = normalizeRecordRef((rowData as { recordRef?: unknown }).recordRef);
  const recordRef = existingRecordRef ?? normalizeRecordRef(opts.recordRef);
  const { error: writeError } = await db.from("portal_inbox_thread_records").upsert(
    {
      id: target.threadId,
      scope: target.scope,
      owner_user_id: target.ownerUserId,
      participant_email: target.participantEmail,
      row_data: {
        ...rowData,
        messages,
        preview: opts.text.slice(0, 100).replace(/\n/g, " "),
        // Advance the thread stamp: the conversation lists order on this field,
        // so an append that leaves it stale never floats the thread.
        time: when,
        unread: false,
        ...(recordRef ? { recordRef } : {}),
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (writeError) throw new Error("Could not save the reply. Please try again.", { cause: writeError });
  return opts.delivery;
}

/**
 * Resolve + commit in one step. Safe only where thread ownership is the ONLY
 * gate the reply has to clear; a caller that can still refuse the send after
 * this point must use `resolveInboxThreadReplyTarget` and defer the commit.
 */
export async function appendInboxThreadReply(
  db: SupabaseClient,
  opts: {
    threadId: string;
    senderUserId: string;
    senderEmail: string;
    fromName: string;
    text: string;
    attachments?: { url: string; name?: string }[];
  },
): Promise<{ ok: boolean; thread?: { threadType: string; ownerUserId: string | null } }> {
  const target = await resolveInboxThreadReplyTarget(db, opts);
  if (!target) return { ok: false };
  await commitInboxThreadReply(db, target, opts);
  return { ok: true, thread: { threadType: target.threadType, ownerUserId: target.ownerUserId } };
}

/**
 * One side of a person-thread: the sender's "sent" copy or the recipient's
 * "inbox" copy of the conversation. `otherPartyEmail` is stored in
 * `row_data.email` and is the person the thread is WITH (the recipient on a
 * sent copy, the sender on an inbox copy) — it is what makes "sent 4 times to
 * one person" one thread instead of four.
 */
export type PortalMessageThreadSide = {
  scope: string;
  folder: "sent" | "inbox";
  /** owner_user_id column (sender on a sent copy; recipient account on an inbox copy — may be null). */
  ownerUserId: string | null;
  /** participant_email column (null on a sent copy; recipient email on an inbox copy). */
  participantEmail: string | null;
  /** row_data.email — the other party in the conversation. */
  otherPartyEmail: string;
  /**
   * What the conversation resolver may use to place this side in a workspace and
   * under a person key: the house, the counterparty's phone / account, the
   * work line the message used. All optional - with none, the resolver falls
   * back to the owner's default workspace and the counterparty's email.
   */
  conversation?: ConversationHints & { workLine?: string | null };
};

/**
 * Find the ONE existing `portal_message` thread for a person-pair so repeated
 * sends append instead of minting a fresh row each time. Matches on the stable
 * top-level columns (scope + thread_type + owner/participant) and then on the
 * `row_data.{folder,email}` pair in JS — JSON-path `.eq` filters are not
 * portable across our fake test client, and the extra rows per identity are few
 * (one per counterparty). Returns the newest match or null.
 */
export type ExistingPortalMessageThread = {
  id: string;
  rowData: Record<string, unknown>;
  ownerUserId: string | null;
  participantEmail: string | null;
  scope: string;
  updatedAt: string | null;
  /**
   * True when the matched row's CURRENT folder is "trash" (archived). The
   * caller decides whether this delivery may reopen it — only a genuinely
   * inbound turn does (see `deliverPortalMessageThreadSide`'s `reopens`).
   */
  archived: boolean;
  /** The stored type of the matched row (a keyed row may be any person-thread type). */
  threadType: string | null;
  /** True when the row was found by its conversation key rather than the legacy email match. */
  matchedByKey: boolean;
};

export async function findExistingPortalMessageThread(
  db: SupabaseClient,
  side: PortalMessageThreadSide,
  /**
   * The side's resolved conversation. `undefined` = resolve it here; `null` =
   * the caller already tried and there is none (legacy match only).
   */
  resolved?: ConversationRef | null,
): Promise<ExistingPortalMessageThread | null> {
  // The conversation key is the identity. One person in one workspace is ONE
  // row regardless of which folder, thread type or channel it started in.
  const ref = resolved === undefined ? await resolveConversationRef(db, side, side.conversation ?? {}) : resolved;
  if (ref) {
    const keyed = await findThreadByConversation(db, side, ref);
    if (keyed) {
      return {
        id: keyed.id,
        rowData: keyed.rowData,
        ownerUserId: keyed.ownerUserId,
        participantEmail: keyed.participantEmail,
        scope: keyed.scope || side.scope,
        updatedAt: keyed.updatedAt,
        archived: keyed.archived,
        threadType: keyed.threadType,
        matchedByKey: true,
      };
    }
  }
  return findLegacyPortalMessageThread(db, side, ref ?? null);
}

async function findLegacyPortalMessageThread(
  db: SupabaseClient,
  side: PortalMessageThreadSide,
  ref: ConversationRef | null,
): Promise<ExistingPortalMessageThread | null> {
  const matchCol = side.folder === "sent" ? "owner_user_id" : "participant_email";
  const matchVal = side.folder === "sent" ? side.ownerUserId : side.participantEmail;
  if (!matchVal) return null;

  const otherPartyNormalized = side.otherPartyEmail.trim().toLowerCase();
  // The key columns only when a conversation was resolved and the migration is live.
  const legacyColumns: string =
    ref && conversationSchemaAvailable()
      ? "id, row_data, owner_user_id, participant_email, scope, updated_at, conversation_key, workspace_id"
      : "id, row_data, owner_user_id, participant_email, scope, updated_at";
  // Deliberately NOT filtered on `row_data->>folder` at the DB level: an
  // archived row's folder is "trash", not `side.folder`, and filtering it out
  // here made every new message to/from an archived person's thread insert a
  // brand-new duplicate row instead of appending to the real one — history
  // stayed stuck in Archived while a near-empty duplicate appeared in Active
  // (captain resurrection sweep). The JS loop below still matches folder or
  // the archived row's remembered `previousFolder` explicitly.
  const { data } = await db
    .from("portal_inbox_thread_records")
    .select(legacyColumns)
    .eq("scope", side.scope)
    .eq(matchCol, matchVal)
    .eq("row_data->>email", otherPartyNormalized)
    .order("updated_at", { ascending: false })
    .limit(100);

  const rows = (Array.isArray(data) ? data : []) as unknown as {
    id: string;
    row_data: Record<string, unknown> | null;
    owner_user_id: string | null;
    participant_email: string | null;
    scope: string | null;
    updated_at: string | null;
    conversation_key?: string | null;
    workspace_id?: string | null;
  }[];
  const otherParty = side.otherPartyEmail.trim().toLowerCase();
  let archivedMatch: (typeof rows)[number] | null = null;
  for (const r of rows) {
    const rowData = (r.row_data ?? {}) as Record<string, unknown>;
    if (String(rowData.email ?? "").trim().toLowerCase() !== otherParty) continue;
    // A row already filed under ANOTHER workspace is another conversation, even
    // for the same email: workspaces never share a conversation.
    if (ref && r.workspace_id && r.workspace_id !== ref.workspaceId) continue;
    const folder = String(rowData.folder ?? "");
    if (folder === side.folder) {
      return {
        id: String(r.id),
        rowData,
        ownerUserId: r.owner_user_id ?? null,
        participantEmail: r.participant_email ?? null,
        scope: String(r.scope ?? side.scope),
        updatedAt: r.updated_at ?? null,
        archived: false,
        threadType: "portal_message",
        matchedByKey: false,
      };
    }
    // An archived row remembers which side it was via `previousFolder` — only
    // that remembered side may match, never the OTHER side's own row (a
    // trashed "sent" copy is not a match for an "inbox"-side lookup).
    if (!archivedMatch && folder === "trash" && String(rowData.previousFolder ?? "") === side.folder) {
      archivedMatch = r;
    }
  }
  if (archivedMatch) {
    const rowData = (archivedMatch.row_data ?? {}) as Record<string, unknown>;
    return {
      id: String(archivedMatch.id),
      rowData,
      ownerUserId: archivedMatch.owner_user_id ?? null,
      participantEmail: archivedMatch.participant_email ?? null,
      scope: String(archivedMatch.scope ?? side.scope),
      updatedAt: archivedMatch.updated_at ?? null,
      archived: true,
      threadType: "portal_message",
      matchedByKey: false,
    };
  }
  return null;
}

/**
 * Deliver ONE portal message into a person-thread: append to the existing
 * conversation for this (owner/participant, other party) pair, or create it
 * when none exists. This is what collapses several "New message" sends to the
 * same person into a single thread the way normal messaging does. SMS threads
 * are untouched — this only ever writes `thread_type: "portal_message"`.
 * `action: "skipped"` means a `messageId` dedupe suppressed the write.
 */
/**
 * Outbound webhooks for an inbound message. Only the MANAGER's inbox copy fires:
 * `webhook_subscriptions` is keyed on `manager_user_id`, and a resident's or
 * vendor's copy is not a manager event. Ids and statuses only — no sender, no
 * subject, no preview; the receiver reads the thread back through the
 * authorized API. Never throws into the delivery path.
 */
async function emitInboxMessageWebhook(
  args: { folder: "sent" | "inbox"; scope: string; ownerUserId: string | null },
  threadId: string,
  unread: boolean,
): Promise<void> {
  if (args.folder !== "inbox" || args.scope !== MANAGER_INBOX_SCOPE || !args.ownerUserId) return;
  await enqueueWebhookEvent(
    args.ownerUserId,
    "message.received",
    webhookEventBuilders["message.received"]({ threadId, scope: args.scope, unread }),
  );
}

export async function deliverPortalMessageThreadSide(
  db: SupabaseClient,
  args: PortalMessageThreadSide & {
    /** Id used only when creating a brand-new thread. */
    fallbackId: string;
    fromName: string;
    subject: string;
    body: string;
    preview: string;
    /**
     * What this conversation is ABOUT, recorded so the list can label it. The
     * send path already resolves it to gate channels; persisting it here is the
     * only way a reader can tell a tour thread from a rent thread, because
     * nothing else on the row carries a topic. `row_data` is free-form, so
     * there is no migration — but rows written before this carry no category
     * and must render no chip rather than a guessed one.
     */
    category?: NotificationCategory;
    when: string;
    /** Inbox copies mark unread on every new message; sent copies never do. */
    unread: boolean;
    /** Direction of the appended turn from the owner's view (false = inbound). */
    outbound: boolean;
    /**
     * Deterministic id for the appended message. When provided and a message
     * with this id already exists in the thread, the append is skipped — this
     * is what makes a redelivered inbound-email webhook idempotent.
     */
    messageId?: string;
    attachments?: { url: string; name?: string }[];
    /** Channel the turn travelled on; omitted = unknown (never assumed email). */
    channel?: InboxThreadMessageChannel;
    /** Per-turn email subject; the thread-level `subject` above still labels the list. */
    messageSubject?: string;
    /**
     * Stamp this thread as being about a record. On an existing thread this
     * NEVER overwrites an already-stamped `recordRef` — the ref belongs to
     * whoever first composed from that record, not to whatever later message
     * happens to pass one. Structurally invalid values are dropped rather
     * than trusted.
     */
    recordRef?: RecordRef;
    delivery?: "sending" | "sent" | "failed";
    /** Stamped onto the appended turn only — see `InboxThreadMessage.automated`. */
    automated?: boolean;
    /**
     * Stored type for a brand-new row. A keyed conversation that already
     * exists keeps its own type. Defaults to `portal_message`.
     */
    threadType?: string;
    /** The root turn is the owner's own outbound message (a resident's text + the ack that follows). */
    rootOutbound?: boolean;
    /** Turns that follow the root on a brand-new row (a resident's message, then the acknowledgement). */
    followUps?: { id: string; from: string; body: string; at: string; outbound?: boolean }[];
    /**
     * The caller already wrote this very turn into this thread (a reply
     * committed to the thread the user was looking at). With ONE conversation
     * per person the sender's sent copy IS that thread, so appending again would
     * show the turn twice; when the conversation found is this one, skip.
     */
    alreadyRecordedIn?: string;
    /** Internal: one re-read after losing a create race. */
    retried?: boolean;
  },
): Promise<{ action: "append" | "create" | "skipped"; threadId: string; delivery?: "sending" | "sent" | "failed" }> {
  const ref = await resolveConversationRef(db, args, args.conversation ?? {});
  const existing = await findExistingPortalMessageThread(db, args, ref);
  const nowIso = new Date().toISOString();
  const normalizedRecordRef = normalizeRecordRef(args.recordRef);
  // The house this turn is about. Each turn carries its own, so one
  // conversation spanning houses can still be shown (and shared with a
  // co-manager) house by house.
  const houseId = String(args.conversation?.propertyId ?? "").trim() || undefined;
  const houseLabel = houseId ? await propertyLabelFor(db, houseId) : undefined;
  const workLine = String(args.conversation?.workLine ?? "").trim() || undefined;

  if (existing && args.alreadyRecordedIn && existing.id === args.alreadyRecordedIn) {
    return { action: "skipped", threadId: existing.id };
  }

  if (existing) {
    // See the `folder`/`previousFolder` comment further below.
    const reopens = existing.archived && !args.outbound;
    const messages = Array.isArray(existing.rowData.messages)
      ? [...(existing.rowData.messages as unknown[])]
      : [];
    if (args.messageId && existing.rowData.rootMessageId === args.messageId) {
      const prior = typeof existing.rowData.rootDelivery === "string" ? existing.rowData.rootDelivery : undefined;
      const delivery = args.delivery
        ? aggregateVendorSponsoredDelivery([args.delivery], prior as "sending" | "sent" | "failed" | undefined)
        : prior as "sending" | "sent" | "failed" | undefined;
      if (!args.delivery || prior === delivery) return { action: "skipped", threadId: existing.id, ...(delivery ? { delivery } : {}) };
      const { error } = await db.from("portal_inbox_thread_records").upsert({
        id: existing.id, scope: existing.scope, owner_user_id: existing.ownerUserId,
        participant_email: existing.participantEmail, thread_type: existing.threadType ?? "portal_message",
        row_data: { ...existing.rowData, rootDelivery: delivery }, updated_at: nowIso,
      }, { onConflict: "id" });
      if (error) throw new Error("Could not save the reply.", { cause: error });
      return { action: "skipped", threadId: existing.id, ...(delivery ? { delivery } : {}) };
    }
    const duplicate = args.messageId ? messages.findIndex((message) => (message as { id?: unknown } | null)?.id === args.messageId) : -1;
    if (duplicate >= 0) {
      const prior = messages[duplicate] as Record<string, unknown>;
      const previous = typeof prior.delivery === "string" ? prior.delivery : undefined;
      const delivery = args.delivery
        ? aggregateVendorSponsoredDelivery([args.delivery], previous as "sending" | "sent" | "failed" | undefined)
        : previous as "sending" | "sent" | "failed" | undefined;
      if (!args.delivery || previous === delivery) return { action: "skipped", threadId: existing.id, ...(delivery ? { delivery } : {}) };
      messages[duplicate] = { ...prior, delivery };
      const { error } = await db.from("portal_inbox_thread_records").upsert({
        id: existing.id, scope: existing.scope, owner_user_id: existing.ownerUserId,
        participant_email: existing.participantEmail, thread_type: existing.threadType ?? "portal_message",
        row_data: { ...existing.rowData, messages }, updated_at: nowIso,
      }, { onConflict: "id" });
      if (error) throw new Error("Could not save the reply.", { cause: error });
      return { action: "skipped", threadId: existing.id, ...(delivery ? { delivery } : {}) };
    }
    messages.push({
      id: args.messageId ?? `msg-${Date.now().toString(36)}-${messages.length}`,
      from: args.fromName,
      body: args.body,
      at: args.when,
      outbound: args.rootOutbound ? true : args.outbound,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      ...(args.channel ? { channel: args.channel } : {}),
      ...(args.messageSubject?.trim() ? { subject: args.messageSubject.trim() } : {}),
      ...(args.delivery ? { delivery: args.delivery } : {}),
      ...(args.automated ? { automated: true } : {}),
      ...(houseId ? { houseId } : {}),
      ...(houseLabel ? { houseLabel } : {}),
    });
    // Turns that follow the main one (a resident's message, then the acknowledgement).
    for (const turn of args.followUps ?? []) {
      messages.push(houseId ? { ...turn, houseId } : turn);
    }
    // A conversation found by its key may have started as a sent copy; an
    // inbound turn makes it an inbox conversation. An archived one only
    // reopens on inbound (`reopens`), never on an outbound or automated turn.
    const storedFolder = String(existing.rowData.folder ?? "");
    const folderPatch = reopens
      ? { folder: args.folder, previousFolder: undefined }
      : existing.matchedByKey && storedFolder === "sent" && !args.outbound
        ? { folder: "inbox" }
        : {};
    const { error, conflict } = await upsertKeyedThreadRow(
      db,
      {
        id: existing.id,
        scope: existing.scope,
        owner_user_id: existing.ownerUserId,
        participant_email: existing.participantEmail,
        thread_type: existing.matchedByKey ? (existing.threadType ?? "portal_message") : "portal_message",
        row_data: {
          ...existing.rowData,
          // Keep the original root `body` — that is the first message's text and
          // real thread history, not a display field.
          //
          // `subject` IS a display field: it labels the conversation in the list
          // and thread header. Freezing it to the first message ever sent to this
          // person meant a manager could send "Your lease for <unit> is ready" and
          // still see whatever that person's first message was called — in the dev
          // data, a one-character "N" — which reads as a broken inbox. Advance it
          // to the latest message, keeping the previous value when a send carries
          // no subject of its own.
          //
          // Thread IDENTITY is unchanged: it is keyed on owner scope +
          // participant_email, so "s" and "Re: s" still stay one conversation.
          messages,
          subject: args.subject?.trim() || existing.rowData.subject,
          preview: args.preview,
          time: args.when,
          unread: args.unread,
          // Only a genuinely INBOUND turn may reopen an archived thread — an
          // outbound or automated append (a manager send, a reminder, a
          // notice, an assistant copy) never un-archives it (captain
          // resurrection sweep policy). `reopens` covers both writing this
          // upsert's `folder` back to the live value and clearing the
          // remembered `previousFolder`; an outbound append into a still-
          // archived thread keeps its current (trash) folder untouched.
          ...folderPatch,
          ...conversationRowData(ref),
          ...(workLine ? { workLine } : {}),
          // Advance with the latest message, like `subject`: a conversation is
          // about whatever it most recently became about.
          ...(args.category ? { category: args.category } : {}),
          // Never overwrite an existing recordRef — see the param doc above.
          ...(normalizeRecordRef((existing.rowData as { recordRef?: unknown }).recordRef) ?? normalizedRecordRef
            ? { recordRef: normalizeRecordRef((existing.rowData as { recordRef?: unknown }).recordRef) ?? normalizedRecordRef }
            : {}),
        },
        updated_at: nowIso,
      },
      ref,
    );
    // Another writer created this person's conversation between our read and
    // our write: append to theirs instead of failing or forking.
    if (conflict && !args.retried) return deliverPortalMessageThreadSide(db, { ...args, retried: true });
    if (error) throw new Error("Could not save the reply.", { cause: error });
    // A legacy row found by email joins its conversation now, so the next
    // message (from any writer) finds it by key.
    if (ref && !existing.matchedByKey) await adoptThreadIntoConversation(db, existing.id, ref);
    await emitInboxMessageWebhook(args, existing.id, args.unread);
    return { action: "append", threadId: existing.id, ...(args.delivery ? { delivery: args.delivery } : {}) };
  }

  const createRowData: Record<string, unknown> = {
    id: args.fallbackId,
    folder: args.folder,
    from: args.fromName,
    email: args.otherPartyEmail,
    subject: args.subject,
    preview: args.preview,
    body: args.body,
    time: args.when,
    // The root turn's OWN time. `time` advances with every later append (it
    // is the list's sort key), and without `rootAt` the root inherits that
    // moving value — so once anything is appended, the root sorts AFTER the
    // reply to it, and a merged person-thread picks the reply as its first
    // turn: an assistant answer became the thread's `from`, the thread was
    // read as the PropLane Assistant conversation, and its composer
    // defaulted back to In-app.
    rootAt: args.when,
    unread: args.unread,
    scope: args.scope,
    ...(args.category ? { category: args.category } : {}),
    // The root message lives in `body`, not `messages[]` — remember its
    // deterministic id so a redelivered webhook can still dedupe it.
    ...(args.messageId ? { rootMessageId: args.messageId } : {}),
    ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    // The root turn lives in `body`; its channel/subject stamps live beside it
    // under `root*` so the bubble builders can label it like any other turn.
    ...(args.channel ? { rootChannel: args.channel } : {}),
    ...(args.messageSubject?.trim() ? { rootSubject: args.messageSubject.trim() } : {}),
    ...(normalizedRecordRef ? { recordRef: normalizedRecordRef } : {}),
    ...(args.delivery ? { rootDelivery: args.delivery } : {}),
    ...(args.automated ? { rootAutomated: true } : {}),
    ...(args.rootOutbound ? { rootOutbound: true } : {}),
    ...(args.followUps?.length ? { messages: args.followUps } : {}),
    ...(houseId ? { rootHouseId: houseId } : {}),
    ...(houseLabel ? { rootHouseLabel: houseLabel } : {}),
    ...(workLine ? { workLine } : {}),
    ...conversationRowData(ref),
  };
  const threadType = args.threadType ?? "portal_message";
  let createdId = args.fallbackId;
  if (ref) {
    // The ONLY way a person's conversation is created: a database function
    // that takes a lock, so two sends at the same instant make one row.
    const created = await createKeyedThreadRow(db, ref, {
      id: args.fallbackId,
      scope: args.scope,
      ownerUserId: args.ownerUserId,
      participantEmail: args.participantEmail,
      threadType,
      rowData: createRowData,
    });
    if (created.error) throw new Error("Could not save the message.", { cause: created.error });
    if (!created.created) {
      // Lost the race: the winner's row is there now; append to it.
      if (!args.retried) return deliverPortalMessageThreadSide(db, { ...args, retried: true });
      throw new Error("Could not save the message.");
    }
    createdId = created.id;
  } else {
    const { error } = await db.from("portal_inbox_thread_records").upsert(
      {
        id: args.fallbackId,
        scope: args.scope,
        owner_user_id: args.ownerUserId,
        participant_email: args.participantEmail,
        thread_type: threadType,
        row_data: createRowData,
        updated_at: nowIso,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error("Could not save the message.", { cause: error });
  }
  await emitInboxMessageWebhook(args, createdId, args.unread);
  return { action: "create", threadId: createdId, ...(args.delivery ? { delivery: args.delivery } : {}) };
}

/**
 * Owner-dispatcher errors that may clear on their own (a control-plane read, a
 * network blip). Everything else — no consent, STOP, runtime paused, number not
 * sendable, no messaging credit — is a standing "no": the in-app message and
 * email already went, so the text is `skipped` (no outcome is reported for it,
 * which the action-event bus reads as "nothing to retry") rather than a
 * failure retried every five minutes.
 */
export function isTransientOwnerSmsError(error: string | undefined): boolean {
  return /unreadable|unavailable|timeout|network|fetch/i.test(String(error ?? ""));
}

/**
 * One vendor text through the owner SMS dispatcher: consent first (the vendor's
 * own `sms_consent_at`, recorded on the scoped ledger), STOP respected, the
 * workspace number as the sender, messaging credit reserved by the dispatcher
 * before the provider is called. `dedupeKey` is stable per event + vendor, so
 * a replay of the same event queues nothing new.
 */
export async function sendVendorEventSms(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    propertyId: string | null;
    vendorUserId: string | null;
    body: string;
    dedupeKey?: string;
  },
): Promise<"queued" | "failed" | "skipped"> {
  const ownerId = input.ownerManagerUserId.trim();
  const vendorUserId = input.vendorUserId?.trim() ?? "";
  if (!ownerId || !vendorUserId || !input.body.trim()) return "skipped";
  try {
    const { data: profile } = await db
      .from("profiles")
      .select("phone, sms_consent_at")
      .eq("id", vendorUserId)
      .maybeSingle();
    const phone = normalizeE164(String((profile as { phone?: unknown } | null)?.phone ?? ""));
    const consentAt = String((profile as { sms_consent_at?: unknown } | null)?.sms_consent_at ?? "").trim();
    // Consent first: no recorded opt-in means no text, and the other channels still went.
    if (!phone || !consentAt) return "skipped";
    if (await isPhoneOptedOut(db, phone, { userId: vendorUserId })) return "skipped";
    const consent = await ensureVendorConversationConsent(db, {
      managerUserId: ownerId,
      vendorUserId,
      phone,
      sessionId: input.dedupeKey ?? "vendor-event",
      evidence: { consentAt },
    });
    if (!consent.allowed) return "skipped";
    const { enqueueOwnerSms } = await import("@/lib/sms/owner-sms-dispatcher.server");
    const queued = await enqueueOwnerSms(
      {
        managerUserId: ownerId,
        actorUserId: ownerId,
        recipientPhone: phone,
        recipientUserId: vendorUserId,
        body: input.body,
        sendClass: "transactional",
        purpose: "vendor_conversation",
        conversationKey: consent.conversationKey,
        counterpartyRole: "vendor",
        propertyId: input.propertyId,
        dedupeKey: input.dedupeKey,
      },
      db,
    );
    if (queued.ok) return "queued";
    return isTransientOwnerSmsError(queued.error) ? "failed" : "skipped";
  } catch (error) {
    return isTransientOwnerSmsError(error instanceof Error ? error.message : undefined) ? "failed" : "skipped";
  }
}

export async function deliverPortalInboxMessage(
  db: SupabaseClient,
  opts: {
    senderUserId: string;
    senderEmail: string;
    fromName: string;
    subject: string;
    text: string;
    toEmails?: string[];
    toUserIds?: string[];
    broadcastCategories?: ("management" | "resident")[];
    deliverToPortalInbox?: boolean;
    deliverViaEmail?: boolean;
    deliverViaSms?: boolean;
    /** When set, SMS uses this body instead of `text` (keeps inbox/email on the full message). */
    smsText?: string;
    senderRole?: string;
    /**
     * When provided, email/SMS are gated PER RECIPIENT by each recipient's saved
     * notification preferences for this category (via `resolveChannels`) instead
     * of the single global `deliverViaEmail` / `deliverViaSms` booleans. Inbox is
     * always written. When omitted, delivery keeps the exact legacy behavior:
     * the two global booleans apply uniformly to every recipient.
     */
    eventCategory?: NotificationCategory;
    /** Keep durable inbox/email fanout, but defer automated SMS in quiet hours or a digest window. */
    suppressSms?: boolean;
    /** Retry a deferred SMS without re-sending already-delivered inbox/email legs. */
    suppressEmail?: boolean;
    suppressInbox?: boolean;
    /** Deterministic action-event message id. Replays append at most once. */
    messageId?: string;
    /** Which vendor Settings row gates a vendor recipient's email/text. */
    vendorTopic?: VendorNotificationTopic;
    /** A vendor's own visit reminder; see `ResolveChannelsOptions.vendorVisitReminder`. */
    vendorVisitReminder?: boolean;
    /** Emergency: a vendor's quiet-hours bypass applies. */
    urgent?: boolean;
    /**
     * The workspace owner whose number a vendor text leaves from, when it is
     * not the sender (a co-manager acting for the owner). Defaults to the sender.
     */
    ownerManagerUserId?: string;
    /** The house the message is about; picks the workspace line a vendor text leaves from. */
    propertyId?: string | null;
    /**
     * Server-resolved existing work-number threads, keyed by recipient email.
     * When supplied, missing/ambiguous entries are reported as unavailable
     * instead of deriving a new user-id thread that could split a prospect's
     * existing conversation.
     */
    smsConversationByEmail?: ReadonlyMap<string, InboxSmsConversationTarget>;
    /** Stamped onto both thread sides when the caller has one (see `RecordRef`). Structurally invalid values are dropped. */
    recordRef?: RecordRef;
    /**
     * True only when this send was generated by PropLane itself (an action
     * event or a reminder), never for a human-typed compose or an
     * `eventCategory` alone — see `InboxThreadMessage.automated`. Stamped on
     * both the recipient's inbox copy and the sender's sent copy.
     */
    automated?: boolean;
    /** The thread this turn was already written into by the caller (see `deliverPortalMessageThreadSide`). */
    alreadyRecordedInThreadId?: string;
    /**
     * The workspace this send speaks for, when it has no browser cookie to read
     * one from (a scheduled message, a cron). The recipient scope is narrowed to
     * it exactly as the interactive route narrows to the active workspace:
     * without it an "All residents" broadcast scheduled in workspace A reached
     * the residents of EVERY workspace the manager owns. `null` / omitted keeps
     * the un-narrowed behaviour (a legacy row, or an unpartitioned account).
     */
    senderWorkspaceId?: string | null;
    /**
     * The caller already proved the recipient set from an authoritative grant
     * (a Property owner writing to the manager of their OWN membership), so
     * the sender-connection filter is skipped. The filter cannot see that
     * connection by design: owner rows are not teammate rows. Never set this
     * from request input.
     */
    recipientsAuthorizedByCaller?: boolean;
  },
): Promise<
  | { ok: true; recipientCount: number; emailOutcomes: InboxEmailOutcome[]; smsOutcomes: InboxSmsOutcome[] }
  | { ok: false; error: string }
> {
  const senderEmail = opts.senderEmail.trim().toLowerCase();
  const subject = opts.subject.trim();
  const text = opts.text.trim();
  const fromName = opts.fromName.trim() || "PropLane Portal";
  // Inbox is always written for category-driven sends (non-suppressible record).
  const deliverToPortalInbox = opts.suppressInbox ? false : opts.eventCategory ? true : opts.deliverToPortalInbox !== false;
  const deliverViaEmail = opts.deliverViaEmail !== false;
  const deliverViaSms = opts.deliverViaSms === true;

  if (!subject || !text) return { ok: false, error: "subject and text are required." };

  const { data: senderProfile } = await db.from("profiles").select("role, sms_from_number").eq("id", opts.senderUserId).maybeSingle();
  const senderRole = String(opts.senderRole ?? senderProfile?.role ?? "manager").trim().toLowerCase() || "manager";

  const recipientsByEmail = new Map<string, InboxDeliveryRecipient>();

  for (const email of (opts.toEmails ?? [])
    .filter((e) => e.includes("@"))
    .map((e) => e.trim().toLowerCase())) {
    if (email === senderEmail || recipientsByEmail.has(email)) continue;
    recipientsByEmail.set(email, { email, userId: null, role: null, scope: RESIDENT_INBOX_SCOPE });
  }

  if (opts.toUserIds?.length) {
    const { data: recipientProfiles } = await db.from("profiles").select("id, email, role").in("id", opts.toUserIds);
    for (const profile of recipientProfiles ?? []) {
      const email = String(profile.email ?? "").trim().toLowerCase();
      if (!email || email === senderEmail) continue;
      const role = String(profile.role ?? "").trim().toLowerCase() || null;
      recipientsByEmail.set(email, {
        email,
        userId: profile.id ?? null,
        role,
        scope: scopeForRole(role),
      });
    }
  }

  if (opts.broadcastCategories?.length) {
    const broadcastRecipients = await resolveBroadcastRecipients(db, opts.senderUserId, opts.broadcastCategories);
    for (const r of broadcastRecipients) {
      if (r.email === senderEmail || recipientsByEmail.has(r.email)) continue;
      recipientsByEmail.set(r.email, { email: r.email, userId: r.userId, role: r.role, scope: scopeForRole(r.role) });
    }
  }

  let recipients = [...recipientsByEmail.values()];
  if (recipients.length === 0) return { ok: false, error: "No recipients selected." };

  // Enforce role scope server-side (mirrors the interactive send route). Scheduled
  // sends are authored by managers or admins; an out-of-scope recipient is rejected
  // here too. Admins are unrestricted — fall back to the role-membership check
  // (mirrors send-inbox-message) since profiles.role may not literally be "admin".
  const senderIsAdmin =
    opts.recipientsAuthorizedByCaller === true ||
    senderRole === "admin" ||
    (await userHoldsAdminRole(db, opts.senderUserId));
  if (!senderIsAdmin) {
    // Same narrowing the interactive route applies: the workspace this send
    // speaks for plus the houses the sender is granted.
    const workspaceId = opts.senderWorkspaceId?.trim() ?? "";
    const reach =
      workspaceId && ["manager", "owner", "pro"].includes(senderRole)
        ? recipientReachFromScope(
            await resolveAgentCommunicationScope(
              { db, userId: opts.senderUserId, workspace: { id: workspaceId } },
              "edit",
            ),
          )
        : undefined;
    const { allowed } = await filterRecipientsBySenderScope(
      db,
      { id: opts.senderUserId, email: senderEmail, role: senderRole, isAdmin: false, reach },
      recipients,
    );
    if (allowed.length === 0) {
      return { ok: false, error: "You can only message people connected to your account." };
    }
    recipients = allowed;
  }

  // Same re-scope as the interactive send route: a Property owner's copy goes
  // to the scope their Messages page reads, decided by the membership and not
  // by the legacy singular `profiles.role`.
  recipients = await applyOwnerMessageInboxScope(db, { userId: opts.senderUserId, role: senderRole }, recipients);

  // Per-recipient channel resolution. With an eventCategory, each recipient's
  // saved notification preferences decide email/SMS (default matrix when they
  // have no row); without one, the legacy global booleans apply to everyone.
  const eventCategory = opts.eventCategory;
  let channelByEmail: Map<string, ResolvedChannels> | null = null;
  if (eventCategory) {
    channelByEmail = new Map();
    // One batched fetch of recipient phone + verification for resolveChannels
    // (which gates SMS on a verified, non-opted-out phone).
    const recipientUserIds = recipients
      .map((r) => r.userId)
      .filter((id): id is string => Boolean(id));
    const profileById = new Map<
      string,
      {
        phone: string | null;
        phone_verified_at: string | null;
        role: string | null;
        sms_from_number: string | null;
        sms_forward_inbound: boolean | null;
      }
    >();
    if (recipientUserIds.length) {
      const { data: recProfiles } = await db
        .from("profiles")
        .select("id, phone, phone_verified_at, role, sms_from_number, sms_forward_inbound")
        .in("id", recipientUserIds);
      for (const p of recProfiles ?? []) {
        profileById.set(String(p.id), {
          phone: (p.phone as string | null) ?? null,
          phone_verified_at: (p.phone_verified_at as string | null) ?? null,
          role: (p.role as string | null) ?? null,
          sms_from_number: (p.sms_from_number as string | null) ?? null,
          sms_forward_inbound: (p.sms_forward_inbound as boolean | null) ?? null,
        });
      }
    }
    for (const recipient of recipients) {
      if (recipient.userId) {
        channelByEmail.set(
          recipient.email,
          await resolveChannels(db, recipient.userId, eventCategory, profileById.get(recipient.userId) ?? null, {
            vendorTopic: opts.vendorTopic,
            vendorVisitReminder: opts.vendorVisitReminder,
            urgent: opts.urgent,
          }),
        );
      } else {
        // Email-only recipient (no account row): no stored prefs and no verified
        // phone, so fall back to the category's default email flag and never SMS.
        channelByEmail.set(recipient.email, {
          inbox: true,
          email: DEFAULT_NOTIFICATION_PREFERENCES[eventCategory].email,
          sms: false,
        });
      }
    }
  }

  const emailWanted = (recipient: InboxDeliveryRecipient): boolean =>
    !opts.suppressEmail && (channelByEmail ? channelByEmail.get(recipient.email)?.email === true : deliverViaEmail);

  // Recipients that will actually receive email (channel on + not a sandbox skip).
  // In legacy mode this collapses to "all non-skip recipients when deliverViaEmail",
  // preserving the previous meaning of `toEmails`.
  const willEmail = new Set<string>(
    recipients.filter((r) => emailWanted(r) && !shouldSkipOutboundEmail(r.email)).map((r) => r.email),
  );
  const toEmails = [...willEmail];
  const emailOutcomes: InboxEmailOutcome[] = recipients.map((recipient) => ({
    recipientEmail: recipient.email,
    status: willEmail.has(recipient.email) ? "failed" : "skipped",
  }));

  if (deliverToPortalInbox) {
    const senderScope = scopeForRole(senderRole);
    const when = formatPacificDateTime(new Date());
    const preview = text.slice(0, 100).replace(/\n/g, " ");

    // The house this send is about, when the caller names it: it picks the
    // workspace the conversation lives in and labels each turn.
    const conversationPropertyId =
      String(opts.propertyId ?? "").trim() ||
      (opts.recordRef?.kind === "property" ? String(opts.recordRef.id ?? "").trim() : "") ||
      null;
    const senderIsManagerSide = senderScope === MANAGER_INBOX_SCOPE;
    for (const recipient of recipients) {
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 6);
      const recipientLower = recipient.email;

      // Sender's "Sent" copy — one thread per recipient; repeated sends append.
      await deliverPortalMessageThreadSide(db, {
        scope: senderScope,
        folder: "sent",
        ownerUserId: opts.senderUserId,
        participantEmail: null,
        otherPartyEmail: recipientLower,
        alreadyRecordedIn: opts.alreadyRecordedInThreadId,
        conversation: {
          propertyId: conversationPropertyId,
          otherPartyUserId: recipient.userId,
          managerUserId: senderIsManagerSide ? opts.senderUserId : recipient.userId,
        },
        fallbackId: `msg_${opts.senderUserId}_${ts}_${rand}`,
        fromName,
        subject,
        body: text,
        preview,
        when,
        unread: false,
        outbound: true,
        category: opts.eventCategory,
        automated: opts.automated,
        messageId: opts.messageId ? `${opts.messageId}:sent:${recipientLower}` : undefined,
        recordRef: opts.recordRef,
      });

      if (recipientLower === senderEmail) continue;

      // Recipient's "Inbox" copy — one thread per sender; repeated sends append.
      await deliverPortalMessageThreadSide(db, {
        scope: recipient.scope,
        folder: "inbox",
        ownerUserId: recipient.userId,
        participantEmail: recipientLower,
        otherPartyEmail: senderEmail,
        conversation: {
          propertyId: conversationPropertyId,
          otherPartyUserId: opts.senderUserId,
          managerUserId: senderIsManagerSide ? (opts.ownerManagerUserId?.trim() || opts.senderUserId) : recipient.userId,
        },
        fallbackId: `msg_inbox_${ts}_${rand}`,
        fromName,
        subject,
        body: text,
        preview,
        when,
        unread: true,
        outbound: false,
        category: opts.eventCategory,
        automated: opts.automated,
        messageId: opts.messageId ? `${opts.messageId}:inbox:${recipientLower}` : undefined,
        recordRef: opts.recordRef,
      });
    }

    // Push notification, best-effort. Generic payload (sender name only) — these
    // messages can carry sensitive lease/payment details. Mirrors the interactive
    // send route so cron/scheduled/agent sends notify the same way.
    try {
      const missingIdEmails = recipients.filter((r) => !r.userId).map((r) => r.email);
      const resolvedIds = new Map<string, string>();
      if (missingIdEmails.length > 0) {
        const { data: resolvedProfiles } = await db
          .from("profiles")
          .select("id, email")
          .in("email", missingIdEmails);
        for (const p of resolvedProfiles ?? []) {
          const email = String(p.email ?? "").trim().toLowerCase();
          if (email) resolvedIds.set(email, p.id as string);
        }
      }
      // ponytail: unbounded Promise.all — fine for direct/scheduled sends; chunk
      // it if a "broadcast to all residents" send ever fans out to a large portfolio.
      await Promise.all(
        recipients.map((r) => {
          const uid = r.userId ?? resolvedIds.get(r.email);
          if (!uid) return Promise.resolve();
          if (channelByEmail && channelByEmail.get(r.email)?.inbox !== true) {
            return Promise.resolve();
          }
          return sendPushToUser(uid, {
            title: `New message from ${fromName}`,
            body: "You have a new message in your PropLane inbox.",
            url: inboxDeepLinkForRole(r.role),
          }).catch(() => {});
        }),
      );
    } catch {
      /* non-critical — no-ops when FCM is not configured */
    }
  }

  if (toEmails.length > 0) {
    const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal by ${String(fromName).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</p>`; // the sender name is display text from the request — never HTML
    // Per-recipient sends carrying the signed Reply-To + threading anchor.
    // Inbox already written — email stays best-effort, now per recipient.
    let emailResults: Awaited<ReturnType<typeof sendPortalConversationEmails>> | null = null;
    try {
      emailResults = await sendPortalConversationEmails({
        senderUserId: opts.senderUserId,
        toEmails,
        subject,
        text,
        html,
        // Resolved per SEND rather than cached: a manager can set up their work email at any
        // time, and the next message should carry it without a deploy.
        fromAddress: await resolveManagerOutboundFrom(db, opts.senderUserId),
      });
    } catch {
      // Portal is already durable. Preserve channel independence and allow the
      // SMS leg to continue while every attempted email remains failed.
    }
    for (const email of toEmails) {
      const sent = emailResults?.get(email)?.sent === true;
      if (!sent) willEmail.delete(email);
      const outcome = emailOutcomes.find((candidate) => candidate.recipientEmail === email);
      if (outcome) outcome.status = sent ? "submitted" : "failed";
    }
  }

  const sentAt = new Date().toISOString();
  for (const recipient of recipients) {
    const logId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await db.from("portal_outbound_mail_records").upsert(
      {
        id: logId,
        recipient_email: recipient.email,
        subject,
        channel: willEmail.has(recipient.email) ? "email" : "portal",
        row_data: {
          id: logId,
          to: recipient.email,
          subject,
          body: text,
          sentAt,
          emailSent: willEmail.has(recipient.email),
        },
      },
      { onConflict: "id" },
    );
  }

  // SMS: legacy mode applies the single global deliverViaSms to every recipient;
  // category mode gates per recipient via resolved channels (verified,
  // non-opted-out phone already enforced by resolveChannels).
  const smsRecipients = recipients.filter((r) =>
    !opts.suppressSms && (channelByEmail ? channelByEmail.get(r.email)?.sms === true : deliverViaSms),
  );
  const smsOutcomes: InboxSmsOutcome[] = [];
  // A caller explicitly selected SMS, but a recipient preference can still
  // close that channel. Report it instead of returning a text-shaped success
  // with no outcome at all.
  const smsExplicitlyRequested = !opts.suppressSms && (channelByEmail !== null || deliverViaSms);
  if (smsExplicitlyRequested) {
    const enabledSmsRecipients = new Set(smsRecipients.map((recipient) => recipient.email));
    for (const recipient of recipients) {
      if (!enabledSmsRecipients.has(recipient.email)) {
        smsOutcomes.push({ recipientEmail: recipient.email, status: "unavailable" });
      }
    }
  }
  // A vendor has no open resident thread and no cached `sms_from_number` on the
  // sender, so the resident path refuses them (`managed_sender_scope_required`).
  // Their text goes through the owner dispatcher directly, on the same
  // consent ledger and credit reservation as the vendor assistant's texts.
  const isVendorRecipient = (r: InboxDeliveryRecipient): boolean =>
    r.scope === VENDOR_INBOX_SCOPE || String(r.role ?? "").toLowerCase() === "vendor";
  const vendorSmsRecipients = smsRecipients.filter(isVendorRecipient);
  const residentPathSmsRecipients = smsRecipients.filter((r) => !isVendorRecipient(r));
  for (const recipient of vendorSmsRecipients) {
    const status = await sendVendorEventSms(db, {
      ownerManagerUserId: opts.ownerManagerUserId?.trim() || opts.senderUserId,
      propertyId: opts.propertyId ?? null,
      vendorUserId: recipient.userId,
      body: (opts.smsText ?? text).trim().slice(0, 1500),
      dedupeKey: opts.messageId ? `vendor-event-sms:${opts.messageId}` : undefined,
    });
    if (status !== "skipped") smsOutcomes.push({ recipientEmail: recipient.email, status });
  }
  if (residentPathSmsRecipients.length > 0) {
    const smsFromNumber = String(senderProfile?.sms_from_number ?? "").trim();
    // The managed dispatcher derives the authoritative work number from the
    // owner. An explicit, server-resolved thread proves that it exists even if
    // the old profiles.sms_from_number cache is blank.
    if (canSendResidentOutboundSms(smsFromNumber) || opts.smsConversationByEmail !== undefined) {
      const recipientEmails = residentPathSmsRecipients.map((r) => r.email);
      const { data: phones } = await db.from("profiles").select("email, phone").in("email", recipientEmails);
      const phoneByEmail = new Map((phones ?? []).map((p) => [String(p.email).toLowerCase(), String(p.phone ?? "").trim()]));
      for (const recipient of residentPathSmsRecipients) {
        const recipientPhone = phoneByEmail.get(recipient.email) ?? "";
        const existingThread = opts.smsConversationByEmail?.get(recipient.email);
        const targetPhone = existingThread ? normalizeE164(existingThread.recipientPhone) : null;
        const currentPhone = normalizeE164(recipientPhone);
        if (
          !currentPhone ||
          (opts.smsConversationByEmail !== undefined &&
            (!existingThread || !targetPhone || targetPhone !== currentPhone))
        ) {
          smsOutcomes.push({ recipientEmail: recipient.email, status: "unavailable" });
          continue;
        }
        const smsBody = (opts.smsText ?? text).trim();
        let body = smsBody.length <= 320 ? smsBody : `${subject}\n\n${smsBody}`.slice(0, 320);
        const recipientIsManager =
          recipient.scope === MANAGER_INBOX_SCOPE ||
          ["manager", "pro", "admin"].includes(String(recipient.role ?? "").toLowerCase());
        const recipientIsResident =
          recipient.scope === RESIDENT_INBOX_SCOPE ||
          String(recipient.role ?? "").toLowerCase() === "resident";
        // Never append resident-portal deep links to manager texts; created-event
        // SMS bodies already carry the manager Services URL when needed.
        const linkKind: ResidentSmsLinkKind | null = recipient.scope?.includes("vendor") || recipientIsManager
          ? null
          : eventCategory === "leases"
            ? "lease"
            : eventCategory === "payments"
              ? "payments"
              : eventCategory === "maintenance"
                ? "services_work_orders"
                : eventCategory === "applications"
                  ? "applications"
                  : "inbox";
        if (linkKind) {
          body = ensureSmsIncludesPortalLink(body, linkKind);
        }
        // Claw resident threads are resident↔manager only. Opening one when the
        // SMS recipient is the manager (e.g. new work-order alert) inverts the
        // roles and breaks manager reply routing.
        const openThread =
          recipientIsResident
            ? {
                managerUserId: opts.senderUserId,
                residentUserId: recipient.userId,
                residentEmail: recipient.email,
                topic:
                  eventCategory === "leases"
                    ? ("lease" as const)
                    : eventCategory === "payments"
                      ? ("payment" as const)
                      : eventCategory === "applications"
                        ? ("applications" as const)
                        : eventCategory === "maintenance"
                          ? ("maintenance" as const)
                        : ("general" as const),
                ...(existingThread
                  ? {
                      conversationKey: existingThread.conversationKey,
                      counterpartyRole: existingThread.counterpartyRole,
                    }
                  : {}),
              }
            : null;
        let result: Awaited<ReturnType<typeof sendResidentOutboundSms>>;
        try {
          result = await sendResidentOutboundSms({
            to: currentPhone,
            text: body,
            fromNumber: smsFromNumber,
            linkKind: null, // already appended above
            sendClass: eventCategory ? "automated" : "transactional",
            openThread,
          });
        } catch {
          smsOutcomes.push({ recipientEmail: recipient.email, status: "failed" });
          continue;
        }
        const outboxStatus = String(result.outboxStatus ?? "").toLowerCase();
        const outcome = outboxStatus === "queued" || outboxStatus === "deferred" || outboxStatus === "unknown"
          ? outboxStatus
          : result.sent
            ? "submitted"
            : result.accepted
              ? "unknown"
              : "failed";
        smsOutcomes.push({ recipientEmail: recipient.email, status: outcome });
        if (result.sent) {
          const logId = `outbound_sms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await db.from("portal_outbound_mail_records").upsert(
            {
              id: logId,
              recipient_email: recipient.email,
              subject,
              channel: "sms",
              row_data: {
                id: logId,
                to: currentPhone,
                subject,
                body: text,
                sentAt,
                smsSent: true,
                smsChannel: result.channel ?? null,
              },
            },
            { onConflict: "id" },
          );
        }
      }
    } else {
      for (const recipient of residentPathSmsRecipients) {
        smsOutcomes.push({ recipientEmail: recipient.email, status: "unavailable" });
      }
    }
  }

  return { ok: true, recipientCount: recipients.length, emailOutcomes, smsOutcomes };
}
