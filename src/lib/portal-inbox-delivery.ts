import { viewerAndLinkedOwnerIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";
import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { filterRecipientsBySenderScope } from "@/lib/inbox-recipient-scope";
import {
  ensureSmsIncludesPortalLink,
  type ResidentSmsLinkKind,
} from "@/lib/claw-resident-links";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { inboxDeepLinkForRole } from "@/lib/platform/parity";
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

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";

export type InboxDeliveryRecipient = {
  email: string;
  userId: string | null;
  role: string | null;
  scope: string;
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
  const threadId = opts.threadId.trim();
  if (!threadId) return null;
  const senderEmail = opts.senderEmail.trim().toLowerCase();
  const { data: threadRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, participant_email, scope, thread_type")
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow) return null;
  const ownerUserId = (threadRow.owner_user_id as string | null) ?? null;
  const isOwner = ownerUserId === opts.senderUserId;
  const isParticipant = String(threadRow.participant_email ?? "").toLowerCase() === senderEmail;
  let delegatedOwner = false;
  if (!isOwner && !isParticipant && ownerUserId) {
    try {
      const ownerIds = await viewerAndLinkedOwnerIdsForModule(
        db as Parameters<typeof viewerAndLinkedOwnerIdsForModule>[0],
        opts.senderUserId,
        "inbox",
        "edit",
      );
      delegatedOwner = ownerIds.includes(ownerUserId);
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
    threadType: String(threadRow.thread_type ?? ""),
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
  },
): Promise<void> {
  const { data: freshRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data")
    .eq("id", target.threadId)
    .maybeSingle();
  if (!freshRow) return;
  const rowData = (freshRow.row_data ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as unknown[])] : [];
  const when = formatPacificDateTime(new Date());
  messages.push({
    id: opts.messageId ?? `reply-${Date.now().toString(36)}`,
    from: opts.fromName,
    body: opts.text,
    at: when,
    ...(opts.outbound !== undefined ? { outbound: opts.outbound } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  });
  await db.from("portal_inbox_thread_records").upsert(
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
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
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
};

/**
 * Find the ONE existing `portal_message` thread for a person-pair so repeated
 * sends append instead of minting a fresh row each time. Matches on the stable
 * top-level columns (scope + thread_type + owner/participant) and then on the
 * `row_data.{folder,email}` pair in JS — JSON-path `.eq` filters are not
 * portable across our fake test client, and the extra rows per identity are few
 * (one per counterparty). Returns the newest match or null.
 */
export async function findExistingPortalMessageThread(
  db: SupabaseClient,
  side: PortalMessageThreadSide,
): Promise<{
  id: string;
  rowData: Record<string, unknown>;
  ownerUserId: string | null;
  participantEmail: string | null;
  scope: string;
  updatedAt: string | null;
} | null> {
  const matchCol = side.folder === "sent" ? "owner_user_id" : "participant_email";
  const matchVal = side.folder === "sent" ? side.ownerUserId : side.participantEmail;
  if (!matchVal) return null;

  const otherPartyNormalized = side.otherPartyEmail.trim().toLowerCase();
  const { data } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, participant_email, scope, updated_at")
    .eq("scope", side.scope)
    .eq(matchCol, matchVal)
    .eq("row_data->>folder", side.folder)
    .eq("row_data->>email", otherPartyNormalized)
    .order("updated_at", { ascending: false })
    .limit(100);

  const rows = (Array.isArray(data) ? data : []) as {
    id: string;
    row_data: Record<string, unknown> | null;
    owner_user_id: string | null;
    participant_email: string | null;
    scope: string | null;
    updated_at: string | null;
  }[];
  const otherParty = side.otherPartyEmail.trim().toLowerCase();
  for (const r of rows) {
    const rowData = (r.row_data ?? {}) as Record<string, unknown>;
    if (String(rowData.folder ?? "") !== side.folder) continue;
    if (String(rowData.email ?? "").trim().toLowerCase() !== otherParty) continue;
    return {
      id: String(r.id),
      rowData,
      ownerUserId: r.owner_user_id ?? null,
      participantEmail: r.participant_email ?? null,
      scope: String(r.scope ?? side.scope),
      updatedAt: r.updated_at ?? null,
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
export async function deliverPortalMessageThreadSide(
  db: SupabaseClient,
  args: PortalMessageThreadSide & {
    /** Id used only when creating a brand-new thread. */
    fallbackId: string;
    fromName: string;
    subject: string;
    body: string;
    preview: string;
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
  },
): Promise<{ action: "append" | "create" | "skipped"; threadId: string }> {
  const existing = await findExistingPortalMessageThread(db, args);
  const nowIso = new Date().toISOString();

  if (existing) {
    const messages = Array.isArray(existing.rowData.messages)
      ? [...(existing.rowData.messages as unknown[])]
      : [];
    if (
      args.messageId &&
      (existing.rowData.rootMessageId === args.messageId ||
        messages.some((m) => (m as { id?: unknown } | null)?.id === args.messageId))
    ) {
      return { action: "skipped", threadId: existing.id };
    }
    messages.push({
      id: args.messageId ?? `msg-${Date.now().toString(36)}-${messages.length}`,
      from: args.fromName,
      body: args.body,
      at: args.when,
      outbound: args.outbound,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });
    await db.from("portal_inbox_thread_records").upsert(
      {
        id: existing.id,
        scope: existing.scope,
        owner_user_id: existing.ownerUserId,
        participant_email: existing.participantEmail,
        thread_type: "portal_message",
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
        },
        updated_at: nowIso,
      },
      { onConflict: "id" },
    );
    return { action: "append", threadId: existing.id };
  }

  await db.from("portal_inbox_thread_records").upsert(
    {
      id: args.fallbackId,
      scope: args.scope,
      owner_user_id: args.ownerUserId,
      participant_email: args.participantEmail,
      thread_type: "portal_message",
      row_data: {
        id: args.fallbackId,
        folder: args.folder,
        from: args.fromName,
        email: args.otherPartyEmail,
        subject: args.subject,
        preview: args.preview,
        body: args.body,
        time: args.when,
        unread: args.unread,
        scope: args.scope,
        // The root message lives in `body`, not `messages[]` — remember its
        // deterministic id so a redelivered webhook can still dedupe it.
        ...(args.messageId ? { rootMessageId: args.messageId } : {}),
        ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      },
      updated_at: nowIso,
    },
    { onConflict: "id" },
  );
  return { action: "create", threadId: args.fallbackId };
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
  },
): Promise<{ ok: true; recipientCount: number } | { ok: false; error: string }> {
  const senderEmail = opts.senderEmail.trim().toLowerCase();
  const subject = opts.subject.trim();
  const text = opts.text.trim();
  const fromName = opts.fromName.trim() || "PropLane Portal";
  // Inbox is always written for category-driven sends (non-suppressible record).
  const deliverToPortalInbox = opts.eventCategory ? true : opts.deliverToPortalInbox !== false;
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
  const senderIsAdmin = senderRole === "admin" || (await userHoldsAdminRole(db, opts.senderUserId));
  if (!senderIsAdmin) {
    const { allowed } = await filterRecipientsBySenderScope(
      db,
      { id: opts.senderUserId, email: senderEmail, role: senderRole, isAdmin: false },
      recipients,
    );
    if (allowed.length === 0) {
      return { ok: false, error: "You can only message people connected to your account." };
    }
    recipients = allowed;
  }

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
          await resolveChannels(db, recipient.userId, eventCategory, profileById.get(recipient.userId) ?? null),
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
    channelByEmail ? channelByEmail.get(recipient.email)?.email === true : deliverViaEmail;

  // Recipients that will actually receive email (channel on + not a sandbox skip).
  // In legacy mode this collapses to "all non-skip recipients when deliverViaEmail",
  // preserving the previous meaning of `toEmails`.
  const willEmail = new Set<string>(
    recipients.filter((r) => emailWanted(r) && !shouldSkipOutboundEmail(r.email)).map((r) => r.email),
  );
  const toEmails = [...willEmail];

  if (deliverToPortalInbox) {
    const senderScope = scopeForRole(senderRole);
    const when = formatPacificDateTime(new Date());
    const preview = text.slice(0, 100).replace(/\n/g, " ");

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
        fallbackId: `msg_${opts.senderUserId}_${ts}_${rand}`,
        fromName,
        subject,
        body: text,
        preview,
        when,
        unread: false,
        outbound: true,
      });

      if (recipientLower === senderEmail) continue;

      // Recipient's "Inbox" copy — one thread per sender; repeated sends append.
      await deliverPortalMessageThreadSide(db, {
        scope: recipient.scope,
        folder: "inbox",
        ownerUserId: recipient.userId,
        participantEmail: recipientLower,
        otherPartyEmail: senderEmail,
        fallbackId: `msg_inbox_${ts}_${rand}`,
        fromName,
        subject,
        body: text,
        preview,
        when,
        unread: true,
        outbound: false,
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
    const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal by ${fromName}</p>`;
    // Per-recipient sends carrying the signed Reply-To + threading anchor.
    // Inbox already written — email stays best-effort, now per recipient.
    const emailResults = await sendPortalConversationEmails({
      senderUserId: opts.senderUserId,
      toEmails,
      subject,
      text,
      html,
      // Resolved per SEND rather than cached: a manager can set up their work email at any
      // time, and the next message should carry it without a deploy.
      fromAddress: await resolveManagerOutboundFrom(db, opts.senderUserId),
    });
    for (const email of toEmails) {
      if (!emailResults.get(email)?.sent) willEmail.delete(email);
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
    channelByEmail ? channelByEmail.get(r.email)?.sms === true : deliverViaSms,
  );
  if (smsRecipients.length > 0) {
    const smsFromNumber = String(senderProfile?.sms_from_number ?? "").trim();
    if (canSendResidentOutboundSms(smsFromNumber)) {
      const recipientEmails = smsRecipients.map((r) => r.email);
      const { data: phones } = await db.from("profiles").select("email, phone").in("email", recipientEmails);
      const phoneByEmail = new Map((phones ?? []).map((p) => [String(p.email).toLowerCase(), String(p.phone ?? "").trim()]));
      for (const recipient of smsRecipients) {
        const recipientPhone = phoneByEmail.get(recipient.email) ?? "";
        if (!recipientPhone) continue;
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
              }
            : null;
        const result = await sendResidentOutboundSms({
          to: recipientPhone,
          text: body,
          fromNumber: smsFromNumber,
          linkKind: null, // already appended above
          sendClass: eventCategory ? "automated" : "transactional",
          openThread,
        });
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
                to: recipientPhone,
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
    }
  }

  return { ok: true, recipientCount: recipients.length };
}
