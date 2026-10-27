import "server-only";

/**
 * A guest message from a booking site (Airbnb, Booking.com, PadSplit, SpareRoom) that reached the workspace work email.
 *
 * The sites have no messaging API PropLane can use; each EMAILS the host every new guest message, and the host points the
 * site's notification address (or a Gmail auto-forward) at the work email. This is the front door for those mails, run
 * BEFORE the sender is classified (a site is not a prospect, a resident or the manager):
 *
 * 1. The sender must be PROVEN. A forged `From: airbnb.com` costs nothing to type, so only a mail whose receiving server
 *    stamped `dkim=pass` / `spf=pass` aligned to the site's domain (`inboundSenderAuthenticated`, read off the received
 *    email's headers - never the From line alone) is read as a guest message. A forwarded mail keeps the site's DKIM
 *    signature, so a Gmail auto-forward still verifies. Anything else is STORED in Communication and NEVER answered.
 * 2. The guest has ONE conversation per site per workspace (the internal key address from `channelGuestKeyAddress`: relay address, else reservation code, else name + listing - never the name alone, through
 *    the same conversation-key resolver as every other person), tagged with the site and the house/room the listing maps to
 *    through the workspace's channel calendar connections.
 * 3. The reply goes through the leasing assistant (credit reserved BEFORE the model, the approval hold and quiet hours
 *    exactly as for texts) and leaves from the work email to the SITE'S RELAY address, which posts it in the guest's thread
 *    on the site. It is HELD instead (stored as a review draft + a notice, never sent) when the guest is writing about
 *    money, a refund, a cancellation or a complaint; when the reply carries contact details a site forbids; when no valid
 *    relay address came with the mail; or when approval/quiet hours say so.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runLeasingEmailAgentTurn } from "@/lib/agent/leasing-email-agent.server";
import { deliverManagerEmailReply } from "@/lib/agent/manager-email-agent.server";
import { CHANNEL_HOLD_REASON_LABEL, channelHoldReason, type ChannelHoldReason } from "@/lib/agent/channel-reply-policy";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { partyFacingAnswerHold } from "@/lib/automation-send-mode.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { matchChannelListing, type ChannelListingMatch, type ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { fetchResendReceivedEmailHeaders } from "@/lib/inbound-email/inbound-email-headers.server";
import { inboundSenderAuthenticated, normalizeInboundHeaders, replyToFromHeaders } from "@/lib/inbound-email/inbound-sender-authentication";
import {
  CHANNEL_SITE_LABEL,
  channelGuestKeyAddress,
  parseChannelGuestMessage,
  quarantinedSenderAddress,
  type ChannelGuestMessage,
  type ChannelSite,
} from "@/lib/inbound-email/channel-senders";
import { isAssistantEmailAddress } from "@/lib/manager-assistant-email/assistant-email-address";
import type { ChannelGuestThreadTag } from "@/lib/manager-assistant-email/channel-guest-thread.server";
import {
  finishEmailAutoReplyCredit,
  reserveEmailAutoReplyCredit,
} from "@/lib/manager-assistant-email/email-auto-reply-credit.server";
import { mirrorAssistantEmailConversation } from "@/lib/manager-assistant-email/mirror-assistant-email-conversation.server";
import { resolveListingTextNumbers, listingTextNumberKey } from "@/lib/listing-text-number.server";
import { rateLimit } from "@/lib/rate-limit";
import { loadServiceWorkspaceIds } from "@/lib/service/service-catalog.server";
import { fanOutWorkspaceNotice, inboundEmailNoticeText, repliedNoticeText } from "@/lib/workspace-team-fanout.server";

export type ChannelGuestResult = {
  handled: true;
  replied: boolean;
  role: "channel";
  /** Why the reply was held for the manager (empty when it was sent or there was nothing to send). */
  held?: string[];
};

type ChannelGuestInput = {
  parsed: ParsedInboundEmail;
  site: ChannelSite;
  managerUserId: string;
  workspaceId: string | null;
  /** The mail body as received (quoted history kept): the parsers read the whole message. */
  rawBody: string;
  /** The body with quoted history stripped - what an unanswered mail is stored as. */
  inboundText: string;
  managerEmail: string;
  /** The work mailbox the reply leaves from; null = it cannot be sent (stored as a draft). */
  mailbox: { address: string } | null;
};

function firstChars(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: Your message";
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function propertyLabelOf(source: Record<string, unknown> | null): string {
  for (const key of ["buildingName", "title", "address", "name"]) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** "+12066781909" -> "(206) 678-1909"; anything else as stored. */
export function formatUsPhone(e164: string | null | undefined): string | null {
  const digits = (e164 ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null;
}

function connectionBelongsToSite(site: ChannelSite, provider: string, label: string | null): boolean {
  if (site === "airbnb") return provider === "airbnb";
  if (site === "booking_com") return provider === "booking_com";
  const name = site === "padsplit" ? /padsplit|pad split/i : /spare ?room/i;
  return provider === "ical" && name.test(label ?? "");
}

/**
 * The rooms the workspace lists on `site`, from its channel calendar connections: one candidate per linked room, with the
 * house label, the room's name, the recorded ad title and the reservation codes already imported for it. Never throws.
 */
export async function loadChannelRoomCandidates(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; site: ChannelSite },
): Promise<ChannelRoomCandidate[]> {
  try {
    const { data, error } = await db.from("external_calendar_connections").select("*").eq("manager_user_id", input.ownerUserId);
    if (error) return [];
    const connections = (data ?? [])
      .map((raw) => parseConnectionRow(raw as Record<string, unknown>))
      .filter((connection) => connectionBelongsToSite(input.site, connection.provider, connection.label));
    if (connections.length === 0) return [];
    const propertyIds = [...new Set(connections.map((connection) => connection.property_id))];
    const { data: properties } = await db
      .from("manager_property_records")
      .select("id, workspace_id, property_data, row_data")
      .eq("manager_user_id", input.ownerUserId)
      .in("id", propertyIds);
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of (properties ?? []) as Record<string, unknown>[]) byId.set(String(row.id), row);

    const out: ChannelRoomCandidate[] = [];
    for (const connection of connections) {
      const property = byId.get(connection.property_id);
      if (!property) continue;
      const rowWorkspace = typeof property.workspace_id === "string" ? property.workspace_id : null;
      if (input.workspaceId && rowWorkspace && rowWorkspace !== input.workspaceId) continue;
      const source = ((property.property_data ?? property.row_data) ?? null) as Record<string, unknown> | null;
      const propertyLabel = propertyLabelOf(source) || connection.property_id;
      const adTitle = typeof source?.alsoListedAs === "string" ? source.alsoListedAs : null;
      let roomLabel = connection.room_id === connection.property_id ? "Whole house" : "";
      try {
        // The raw saved rooms: the name the manager typed, whatever the normalizer would do to the rest of the submission.
        const submission = source?.listingSubmission as { rooms?: unknown } | undefined;
        const rooms = Array.isArray(submission?.rooms) ? (submission.rooms as { id?: unknown; name?: unknown }[]) : [];
        const index = rooms.findIndex((room) => room?.id === connection.room_id);
        if (!roomLabel && index >= 0) roomLabel = (typeof rooms[index]!.name === "string" ? (rooms[index]!.name as string).trim() : "") || `Room ${index + 1}`;
      } catch {
        /* an unreadable submission leaves the room unnamed; the house still matches */
      }
      out.push({
        propertyId: connection.property_id,
        propertyLabel,
        roomId: connection.room_id,
        roomLabel: roomLabel || "Room",
        adTitle,
        reservationCodes: connection.imported_ranges.map((range) => range.reservationCode ?? "").filter(Boolean),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** A genuine site mail replayed to one workspace more than this many times in an hour stops costing credit. */
const CHANNEL_RELAY_TURNS_PER_HOUR = 6;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hashOf(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 24);
}

/**
 * Store the mail in Communication under its sender, answer nothing. The same posture as any inbound the assistant will not answer.
 * A mail that merely CLAIMS one of our synthetic guest keys is filed under a quarantine address instead of the key, so it can
 * never be written into the real guest's conversation.
 */
export async function storeChannelMailUnanswered(
  db: SupabaseClient,
  input: Pick<ChannelGuestInput, "parsed" | "managerUserId" | "workspaceId" | "inboundText" | "managerEmail">,
  why: "not_authenticated" | "not_a_guest_message" | "not_answerable" | "replayed" | "synthetic_sender",
): Promise<ChannelGuestResult> {
  const { parsed, managerUserId, workspaceId, inboundText } = input;
  try {
    const claimed = parsed.fromEmail.trim().toLowerCase();
    const senderEmail = why === "synthetic_sender" ? quarantinedSenderAddress(claimed) : claimed;
    const senderName = why === "synthetic_sender" ? "Unverified sender" : parsed.fromName?.trim() || senderEmail;
    await mirrorAssistantEmailConversation(db, {
      managerUserId,
      managerEmail: input.managerEmail,
      senderEmail,
      senderName,
      subject: parsed.subject,
      inboundText,
      replyText: null,
      inboundEmailId: parsed.emailId,
      replySent: false,
      replyAsReviewDraft: false,
      workspaceId,
      workLine: parsed.toEmails.find((address) => isAssistantEmailAddress([address])) ?? null,
      residentUserId: null,
    });
    await fanOutWorkspaceNotice(db, {
      ownerUserId: managerUserId,
      workspaceId,
      subject: "Work email",
      sms: false,
      text: inboundEmailNoticeText({ sender: senderName, subject: parsed.subject, body: inboundText }),
      idempotencyKey: `inbound-email:${parsed.emailId}`,
    });
  } catch (cause) {
    console.error(`channel guest mail stored without an answer (${why}) failed`, cause);
  }
  return { handled: true, replied: false, role: "channel" };
}

export async function handleChannelGuestEmail(db: SupabaseClient, input: ChannelGuestInput): Promise<ChannelGuestResult> {
  const { parsed, site, managerUserId, workspaceId } = input;
  const siteLabel = CHANNEL_SITE_LABEL[site];

  /* 1. Who really sent it. Unknown (no headers, no key, a failed fetch) is not proven. */
  let headers: Record<string, string[]> | null = parsed.headers ?? null;
  let authenticated = false;
  try {
    headers = headers ?? (await fetchResendReceivedEmailHeaders(parsed.emailId));
    authenticated = inboundSenderAuthenticated(headers, parsed.fromEmail);
  } catch {
    authenticated = false;
  }
  if (!authenticated) return storeChannelMailUnanswered(db, input, "not_authenticated");

  const replyTo = parsed.replyTo ?? replyToFromHeaders(headers);
  const message: ChannelGuestMessage | null = parseChannelGuestMessage({
    fromEmail: parsed.fromEmail,
    subject: parsed.subject,
    text: input.rawBody,
    replyTo,
  });
  if (!message) return storeChannelMailUnanswered(db, input, "not_a_guest_message");

  /* 2. The house and room, from the workspace's own connections for this site. */
  const candidates = await loadChannelRoomCandidates(db, { ownerUserId: managerUserId, workspaceId, site });
  const match: ChannelListingMatch | null = matchChannelListing(
    { site, listingTitle: message.listingTitle, reservationCode: message.reservationCode },
    candidates,
  );
  const listingLine = match
    ? [match.propertyLabel, match.roomLabel].filter(Boolean).join(", ")
    : message.listingTitle;
  const guestKey = channelGuestKeyAddress(site, message.guestName, {
    replyAddress: message.replyAddress,
    reservationCode: message.reservationCode,
    listingTitle: message.listingTitle,
  });
  const holdReason: ChannelHoldReason | null = channelHoldReason(message.messageText);

  let serviceWorkspace = false;
  try {
    serviceWorkspace = Boolean(workspaceId) && (await loadServiceWorkspaceIds(db)).includes(workspaceId!);
  } catch {
    serviceWorkspace = false;
  }
  let proplaneLine: string | null = null;
  if (site === "padsplit" || site === "spareroom") {
    try {
      const numbers = await resolveListingTextNumbers(db, [{ ownerUserId: managerUserId, workspaceId }]);
      proplaneLine = formatUsPhone(numbers.get(listingTextNumberKey({ ownerUserId: managerUserId, workspaceId })));
    } catch {
      proplaneLine = null;
    }
  }

  /* A genuine site mail can be replayed (it keeps its DKIM signature) to the same workspace again and again, each a paid turn:
     the same RFC Message-ID is answered once per workspace, and one relay thread gets a bounded number of turns an hour. No
     new table: the shared limiter holds both counts. An unreadable limiter denies, so the mail is only stored. */
  const workspaceKey = workspaceId ?? managerUserId;
  const messageId = normalizeInboundHeaders(headers)["message-id"]?.[0]?.trim();
  if (messageId && !(await rateLimit(`channel-msgid:${workspaceKey}:${hashOf(messageId)}`, 1, DAY_MS)).ok) {
    return storeChannelMailUnanswered(db, input, "replayed");
  }
  const relayHash = guestKey.slice(0, guestKey.indexOf("@"));
  if (!(await rateLimit(`channel-relay:${workspaceKey}:${relayHash}`, CHANNEL_RELAY_TURNS_PER_HOUR, HOUR_MS)).ok) {
    return storeChannelMailUnanswered(db, input, "replayed");
  }

  /* 3. A paid turn: credit before any model work, the approval hold and quiet hours as for texts (unreadable = hold). */
  const credit = await reserveEmailAutoReplyCredit(db, {
    managerUserId,
    workspaceId,
    inboundEmailId: parsed.emailId,
    role: "prospect",
  });
  if (!credit.allowed) {
    console.warn("channel guest auto-reply skipped: comms credit not reserved", { managerUserId, reason: credit.reason });
  }
  let approvalHold = false;
  if (credit.allowed) {
    try {
      approvalHold = (await partyFacingAnswerHold(db, managerUserId)).hold;
    } catch (cause) {
      console.error("channel guest send mode lookup failed; holding for review", cause);
      approvalHold = true;
    }
  }

  let replyText = "";
  let violations: string[] = [];
  try {
    if (credit.allowed) {
      const turn = await runLeasingEmailAgentTurn(db, {
        landlordId: managerUserId,
        prospectEmail: guestKey,
        inboundText: message.messageText,
        inboundEmailId: parsed.emailId,
        channel: { site, guestName: message.guestName, listingLine, holdReason, serviceWorkspace, proplaneLine },
      });
      replyText = turn?.reply?.trim() ?? "";
      violations = turn?.channel?.violations ?? [];
    }
  } catch (cause) {
    if (credit.allowed) await finishEmailAutoReplyCredit(db, { managerUserId, key: credit.key, replyProduced: false });
    throw cause;
  }
  if (credit.allowed) await finishEmailAutoReplyCredit(db, { managerUserId, key: credit.key, replyProduced: Boolean(replyText) });

  /* 4. Send, or hold. Every reason to hold is a draft the manager sends with one tap; a sent reply cannot be recalled. */
  const heldReasons: string[] = [];
  if (holdReason) heldReasons.push(CHANNEL_HOLD_REASON_LABEL[holdReason]);
  if (approvalHold) heldReasons.push("your approval setting");
  if (violations.length) heldReasons.push(`contact details the site forbids (${violations.join(", ")})`);
  if (!message.replyAddress) heldReasons.push(`no ${siteLabel} reply address came with the message`);
  if (!input.mailbox) heldReasons.push("no work email to send from");

  let replied = false;
  if (replyText && heldReasons.length === 0 && message.replyAddress && input.mailbox) {
    const send = await deliverManagerEmailReply({
      managerUserId,
      toEmail: message.replyAddress,
      subject: replySubject(parsed.subject),
      text: replyText,
      fromAddress: input.mailbox.address,
      replyTo: input.mailbox.address,
      channel: { site, authenticated: true },
    });
    replied = send.ok;
    if (!send.ok) heldReasons.push("the send failed");
  }
  const storedAsDraft = Boolean(replyText) && !replied;

  const tag: ChannelGuestThreadTag = {
    site,
    siteLabel,
    guestName: message.guestName,
    propertyId: match?.propertyId ?? null,
    propertyLabel: match?.propertyLabel ?? null,
    roomId: match?.roomId ?? null,
    roomLabel: match?.roomLabel ?? null,
    replyAddress: message.replyAddress,
    held: storedAsDraft,
  };
  try {
    await mirrorAssistantEmailConversation(db, {
      managerUserId,
      managerEmail: input.managerEmail,
      senderEmail: guestKey,
      // The site (and room) ride in the name the list shows; the house is the conversation's own house label.
      senderName: [message.guestName, siteLabel, match?.roomLabel].filter(Boolean).join(" · "),
      subject: parsed.subject,
      inboundText: message.messageText,
      replyText: replyText || null,
      inboundEmailId: parsed.emailId,
      replySent: replied,
      replyAsReviewDraft: storedAsDraft,
      workspaceId,
      workLine: parsed.toEmails.find((address) => isAssistantEmailAddress([address])) ?? null,
      residentUserId: null,
      propertyId: match?.propertyId ?? null,
      channelGuest: tag,
    });
  } catch (cause) {
    console.error("channel guest conversation mirror failed", cause);
  }

  /* 5. Tell the manager and the team. A held reply asks for the manager; a sent one says what went out. */
  const where = listingLine ? ` · ${listingLine}` : "";
  try {
    if (storedAsDraft) {
      const text = `Held for you · ${message.guestName} on ${siteLabel}${where} · ${heldReasons.join("; ")} · "${firstChars(message.messageText, 100)}"`;
      await notifyManagerFromAgent(db, {
        landlordId: managerUserId,
        subject: "Guest message held",
        text,
        category: "messages",
        notify: { push: true, sms: false },
        idempotencyKey: `channel-held:${parsed.emailId}`,
        propertyId: match?.propertyId ?? null,
        workspaceId,
      });
      await fanOutWorkspaceNotice(db, {
        ownerUserId: managerUserId,
        workspaceId,
        propertyId: match?.propertyId ?? null,
        subject: "Guest message held",
        sms: false,
        text,
        idempotencyKey: `channel-held:${parsed.emailId}:team`,
      });
    } else {
      await fanOutWorkspaceNotice(db, {
        ownerUserId: managerUserId,
        workspaceId,
        propertyId: match?.propertyId ?? null,
        subject: "Work email",
        sms: false,
        text: inboundEmailNoticeText({ sender: `${message.guestName} (${siteLabel})`, subject: parsed.subject, body: message.messageText }),
        idempotencyKey: `inbound-email:${parsed.emailId}`,
      });
      if (replied) {
        await fanOutWorkspaceNotice(db, {
          ownerUserId: managerUserId,
          workspaceId,
          propertyId: match?.propertyId ?? null,
          subject: "Work email reply",
          sms: false,
          text: repliedNoticeText(replyText),
          idempotencyKey: `inbound-email-reply:${parsed.emailId}`,
        });
      }
    }
  } catch (cause) {
    console.error("channel guest notice failed", cause);
  }

  return { handled: true, replied, role: "channel", ...(storedAsDraft ? { held: heldReasons } : {}) };
}
