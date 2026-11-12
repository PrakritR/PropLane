import "server-only";

/**
 * Platform inquiries as LEADS (design-1112 §6). A prospect who writes on SpareRoom, Roomies, Zillow, Craigslist, Facebook or
 * Roomster reaches PropLane only as the site's own notification / relay EMAIL, on the workspace work email. This is the
 * front door for those mails (run before the sender is classified), and it only READS: no scraping, no headless session,
 * no API the site did not publish.
 *
 *   authenticate (DKIM/SPF, the receiving server's verdict) -> parse (site parser or generic fallback) -> match the listing
 *   and room against the workspace's own listings -> `recordInbound` (ONE thread, tagged "SpareRoom · 4709a Room 9",
 *   notified like a text) -> stitch to the phone-keyed record when the mail carries a phone -> reply:
 *     email_relay  : the answer leaves by the site's relay address (on the site's own domain only);
 *     manual_copy  : the answer is stored as a draft with the site's open-link, nothing is sent.
 *   Once the prospect texts the line (stitch code quoted, or their phone matches) the thread is MOVED: this module never
 *   answers on the platform again, and a late platform mail is appended with "They moved to text".
 *
 * The orchestration runs over ports (`LeadIngestDeps`) so the unit tests drive it with the spine mocked.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { channelHoldReason, CHANNEL_HOLD_REASON_LABEL, type ChannelHoldReason } from "@/lib/agent/channel-reply-policy";
import { runLeasingEmailAgentTurn } from "@/lib/agent/leasing-email-agent.server";
import { deliverManagerEmailReply } from "@/lib/agent/manager-email-agent.server";
import { partyFacingAnswerHold } from "@/lib/automation-send-mode.server";
import { matchChannelListing, type ChannelListingMatch, type ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";
import type { ChannelSite } from "@/lib/inbound-email/channel-senders";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { fetchResendReceivedEmailHeaders } from "@/lib/inbound-email/inbound-email-headers.server";
import { inboundSenderAuthenticated, normalizeInboundHeaders, replyToFromHeaders } from "@/lib/inbound-email/inbound-sender-authentication";
import { isLeadRelayAddress, leadSiteOfAddress, parsePlatformLead, PLATFORM_LEAD_LABEL, type PlatformLeadMessage, type PlatformLeadSite } from "@/lib/inbound-email/platform-lead-parsers";
import { listingTextNumberKey, resolveListingTextNumbers } from "@/lib/listing-text-number.server";
import { formatUsPhone, storeChannelMailUnanswered, type ChannelGuestResult } from "@/lib/manager-assistant-email/channel-guest-message.server";
import { stampThreadRowData } from "@/lib/manager-assistant-email/channel-guest-thread.server";
import { finishEmailAutoReplyCredit, reserveEmailAutoReplyCredit } from "@/lib/manager-assistant-email/email-auto-reply-credit.server";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
import { CHANNEL_CAPABILITIES } from "@/lib/platform-leads/capabilities";
import { composePlatformReply } from "@/lib/platform-leads/compose";
import { loadLeadRoomCandidates } from "@/lib/platform-leads/candidates.server";
import { contextLabel, mintStitchCode, recordInbound, recordOutbound, stitchByPhone } from "@/lib/prospect-spine/index.server";
import type { ProspectIdentity, RecordInboundInput, RecordInboundResult, StitchResult } from "@/lib/prospect-spine/contracts";
import { rateLimit } from "@/lib/rate-limit";
import { loadServiceWorkspaceIds } from "@/lib/service/service-catalog.server";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A genuine lead mail replayed to one workspace more than this many times an hour stops costing credit. */
export const LEAD_RELAY_TURNS_PER_HOUR = 6;

const hash = (value: string, length = 24) => createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, length);

export type LeadIngestInput = {
  emailId: string;
  /** The RFC Message-ID header: the idempotency key of the turn. */
  messageIdHeader: string | null;
  site: PlatformLeadSite;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  rawBody: string;
  replyTo: string | null;
  receivedAt: string;
  workspaceId: string;
  ownerUserId: string;
  /** The work mailbox a relay reply leaves from; null = it cannot be sent (a draft instead). */
  mailbox: { address: string } | null;
  authenticated: boolean;
};

export type LeadAnswer = { reply: string; violations: string[]; approvalHold: boolean; produced: boolean };

export interface LeadIngestDeps {
  loadCandidates(): Promise<ChannelRoomCandidate[]>;
  textNumber(): Promise<{ e164: string | null; display: string | null }>;
  spine: {
    recordInbound(input: RecordInboundInput): Promise<RecordInboundResult>;
    mintStitchCode(contextId: string): Promise<string | null>;
    stitchByPhone(input: { contextId: string; phoneE164: string }): Promise<StitchResult>;
    recordOutbound(input: { threadId: string; body: string; eventId: string; author: "assistant" }): Promise<void>;
  };
  contextState(contextId: string): Promise<"active" | "moved">;
  /** Reserves credit, runs the leasing assistant, settles credit. */
  generateAnswer(input: { lead: PlatformLeadMessage; match: ChannelListingMatch | null; listingLine: string | null; holdReason: ChannelHoldReason | null; textNumberDisplay: string | null; handle: string }): Promise<LeadAnswer>;
  sendRelay(input: { to: string; subject: string; text: string; from: string }): Promise<boolean>;
  stampThread(threadId: string, patch: Record<string, unknown>): Promise<void>;
  rateOk(key: string, limit: number, windowMs: number): Promise<boolean>;
  storeUnanswered(why: "not_authenticated" | "not_a_guest_message" | "not_answerable" | "replayed"): Promise<ChannelGuestResult>;
  notify(text: string, key: string, propertyId: string | null): Promise<void>;
}

export type LeadIngestResult = ChannelGuestResult & { threadId?: string; contextId?: string; mode?: "email_relay" | "manual_copy" | "moved" | "none" };

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return !trimmed ? "Re: Your message" : /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function leadContactHandle(site: PlatformLeadSite, lead: PlatformLeadMessage, listingLine: string | null): string {
  return hash(`${site}|${lead.replyAddress ?? lead.platformThreadId ?? `${lead.senderName}|${listingLine ?? lead.listingHint ?? ""}`}`, 32);
}

export async function ingestPlatformLead(deps: LeadIngestDeps, input: LeadIngestInput, options: { enabledParsers?: ReadonlySet<PlatformLeadSite> } = {}): Promise<LeadIngestResult> {
  const { site } = input;
  const label = PLATFORM_LEAD_LABEL[site];
  if (!input.authenticated) return deps.storeUnanswered("not_authenticated");

  const number = await deps.textNumber();
  const lead = parsePlatformLead(
    { fromEmail: input.fromEmail, fromName: input.fromName, subject: input.subject, text: input.rawBody, replyTo: input.replyTo, excludePhones: [number.e164 ?? "", "+12066781909", "+15103098345"] },
    { enabled: options.enabledParsers },
  );
  if (!lead) return deps.storeUnanswered("not_a_guest_message");

  /* The house and room: the mail's own words read against EVERY listing of the workspace (address, ad title, room text). */
  const candidates = await deps.loadCandidates();
  const match = matchChannelListing(
    { site: "spareroom" as ChannelSite, listingTitle: [lead.listingHint, lead.roomHint].filter(Boolean).join(" ") || null, reservationCode: null },
    candidates,
  );
  const placeLine = match ? [match.propertyLabel, match.roomLabel].filter(Boolean).join(", ") : lead.listingHint;
  const handle = leadContactHandle(site, lead, placeLine);

  /* A genuine lead mail keeps its DKIM signature, so it can be replayed: one Message-ID once a day, bounded turns per thread. */
  const msgKey = input.messageIdHeader ? hash(input.messageIdHeader) : hash(input.emailId);
  if (input.messageIdHeader && !(await deps.rateOk(`platform-lead-msgid:${input.workspaceId}:${msgKey}`, 1, DAY_MS))) return deps.storeUnanswered("replayed");
  const replayCapped = !(await deps.rateOk(`platform-lead-thread:${input.workspaceId}:${handle}`, LEAD_RELAY_TURNS_PER_HOUR, HOUR_MS));

  const identity: ProspectIdentity = { kind: "handle", contactHandle: handle, site, displayName: lead.senderName, replyAddress: lead.replyAddress };
  const recorded = await deps.spine.recordInbound({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    identity,
    context: { propertyId: match?.propertyId ?? null, roomId: match?.roomId ?? null, roomLabel: match?.roomLabel ?? lead.roomHint, source: site, sourceRef: lead.listingUrl },
    body: lead.body,
    channel: "email",
    eventId: `mail:${msgKey}`,
    occurredAt: input.receivedAt,
  });
  if (!recorded.ok) return deps.storeUnanswered("not_answerable");
  if (recorded.duplicate) return { handled: true, replied: false, role: "channel", threadId: recorded.threadId, contextId: recorded.contextId, mode: "none" };
  const tag = recorded.label || contextLabel({ propertyLabel: match?.propertyLabel ?? null, roomLabel: match?.roomLabel ?? lead.roomHint, sourceLabel: label });

  /* Moved to text: the prospect is on the line now. A late platform mail is stored and alerts; it is never answered there. */
  if ((await deps.contextState(recorded.contextId)) === "moved") {
    await deps.notify(`They moved to text · ${lead.senderName} wrote again on ${label} · ${tag}`, `platform-moved:${msgKey}`, match?.propertyId ?? null);
    return { handled: true, replied: false, role: "channel", held: ["They moved to text"], threadId: recorded.threadId, contextId: recorded.contextId, mode: "moved" };
  }

  /* A phone number in the message merges the THREAD under the phone key now (never an account: that needs the SMS code). */
  let threadId = recorded.threadId;
  if (lead.phoneInBody) {
    const stitched = await deps.spine.stitchByPhone({ contextId: recorded.contextId, phoneE164: lead.phoneInBody });
    if (stitched.ok) {
      threadId = stitched.threadId;
      // The phone already texts the line: the prospect is on text, so this platform mail is stored and never answered there.
      if (stitched.moved) {
        await deps.notify(`They moved to text · ${lead.senderName} wrote again on ${label} · ${tag}`, `platform-moved:${msgKey}`, match?.propertyId ?? null);
        return { handled: true, replied: false, role: "channel", held: ["They moved to text"], threadId, contextId: recorded.contextId, mode: "moved" };
      }
    }
  }
  const code = await deps.spine.mintStitchCode(recorded.contextId);
  await deps.stampThread(threadId, { platformState: { site, state: "active", stitchCode: code }, platformLead: { site, siteLabel: label, senderName: lead.senderName, tag, via: lead.via } });

  /* The answer: through the leasing assistant, then recomposed for what THIS site allows. */
  const capability = CHANNEL_CAPABILITIES[site];
  const holdReason = channelHoldReason(lead.body);
  const answer = replayCapped
    ? ({ reply: "", violations: [], approvalHold: false, produced: false } satisfies LeadAnswer)
    : await deps.generateAnswer({ lead, match, listingLine: placeLine, holdReason, textNumberDisplay: number.display, handle });
  if (!answer.reply.trim()) return { handled: true, replied: false, role: "channel", threadId, contextId: recorded.contextId, mode: "none" };

  const composed = composePlatformReply({
    site,
    answer: answer.reply,
    propertyLabel: match?.propertyLabel ?? "",
    roomLabel: match?.roomLabel ?? lead.roomHint,
    listingUrl: capability.allowsLinkInMessage ? lead.listingUrl : null,
    textNumberDisplay: number.display ?? "",
    stitchCode: code,
  });

  const held: string[] = [];
  if (holdReason) held.push(CHANNEL_HOLD_REASON_LABEL[holdReason]);
  if (answer.approvalHold) held.push("your approval setting");
  const relayOk = capability.replyMode === "email_relay" && Boolean(lead.replyAddress) && isLeadRelayAddress(site, lead.replyAddress);
  if (capability.replyMode === "email_relay" && !relayOk) held.push(`no ${label} reply address came with the message`);
  if (!input.mailbox) held.push("no work email to send from");

  let mode: "email_relay" | "manual_copy" = "manual_copy";
  let replied = false;
  if (relayOk && held.length === 0 && input.mailbox && lead.replyAddress) {
    replied = await deps.sendRelay({ to: lead.replyAddress, subject: replySubject(input.subject), text: composed.body, from: input.mailbox.address });
    if (replied) {
      mode = "email_relay";
      await deps.spine.recordOutbound({ threadId, body: composed.body, eventId: `reply:${msgKey}`, author: "assistant" });
    } else held.push("the send failed");
  }
  if (!replied) {
    // A draft the manager copies (manual_copy) or sends with one tap (a relay that was held): nothing leaves PropLane.
    await deps.stampThread(threadId, {
      platformDraft: { site, siteLabel: label, body: composed.body, removed: composed.removed, openUrl: lead.listingUrl, replyMode: capability.replyMode, held, createdAt: new Date().toISOString(), forMessage: msgKey },
    });
    await deps.notify(
      `${capability.replyMode === "manual_copy" ? "Reply ready to copy" : "Held for you"} · ${lead.senderName} on ${label} · ${tag}${held.length ? ` · ${held.join("; ")}` : ""}`,
      `platform-draft:${msgKey}`,
      match?.propertyId ?? null,
    );
  }
  return { handled: true, replied, role: "channel", ...(held.length && !replied ? { held } : {}), threadId, contextId: recorded.contextId, mode };
}

/* ───────────────────────── the real ports ───────────────────────── */

async function loadMailboxHeaders(parsed: ParsedInboundEmail): Promise<Record<string, string[]> | null> {
  let headers = parsed.headers ?? null;
  try {
    headers = headers ?? (await fetchResendReceivedEmailHeaders(parsed.emailId));
  } catch {
    headers = null;
  }
  return headers;
}

export type PlatformLeadEmailInput = {
  parsed: ParsedInboundEmail;
  managerUserId: string;
  workspaceId: string | null;
  rawBody: string;
  inboundText: string;
  managerEmail: string;
  mailbox: { address: string } | null;
};

/** The entry the inbound email path calls for a mail whose sender is one of the lead sites. */
export async function handlePlatformLeadEmail(db: SupabaseClient, input: PlatformLeadEmailInput): Promise<LeadIngestResult> {
  const { parsed, managerUserId, workspaceId } = input;
  const site = leadSiteOfAddress(parsed.fromEmail);
  const base = { parsed, managerUserId, workspaceId, inboundText: input.inboundText, managerEmail: input.managerEmail };
  if (!site || !workspaceId) return storeChannelMailUnanswered(db, base, "not_a_guest_message");

  const headers = await loadMailboxHeaders(parsed);
  let authenticated = false;
  try {
    authenticated = inboundSenderAuthenticated(headers, parsed.fromEmail);
  } catch {
    authenticated = false;
  }
  const replyTo = parsed.replyTo ?? replyToFromHeaders(headers);

  const deps: LeadIngestDeps = {
    loadCandidates: () => loadLeadRoomCandidates(db, { ownerUserId: managerUserId, workspaceId }),
    textNumber: async () => {
      try {
        const numbers = await resolveListingTextNumbers(db, [{ ownerUserId: managerUserId, workspaceId }]);
        const e164 = numbers.get(listingTextNumberKey({ ownerUserId: managerUserId, workspaceId })) ?? null;
        if (e164) return { e164, display: formatUsPhone(e164) };
      } catch {
        /* the public line is the fallback */
      }
      const config = await getPublicTextingConfig().catch(() => ({ phone: null as string | null }));
      return { e164: config.phone ?? null, display: formatUsPhone(config.phone) };
    },
    spine: {
      recordInbound: (i) => recordInbound(db, i),
      mintStitchCode: (contextId) => mintStitchCode(db, contextId),
      stitchByPhone: (i) => stitchByPhone(db, i),
      recordOutbound: async (i) => {
        await recordOutbound(db, { workspaceId, ownerUserId: managerUserId, threadId: i.threadId, body: i.body, channel: "email", author: { kind: "assistant" }, eventId: i.eventId });
      },
    },
    contextState: async (contextId) => {
      const { data } = await db.from("prospect_contexts").select("channel_state").eq("id", contextId).maybeSingle();
      return (data as { channel_state?: string } | null)?.channel_state === "moved" ? "moved" : "active";
    },
    generateAnswer: async ({ lead, listingLine, holdReason, textNumberDisplay, handle }) => {
      const credit = await reserveEmailAutoReplyCredit(db, { managerUserId, workspaceId, inboundEmailId: parsed.emailId, role: "prospect" });
      if (!credit.allowed) return { reply: "", violations: [], approvalHold: false, produced: false };
      let approvalHold = false;
      try {
        approvalHold = (await partyFacingAnswerHold(db, managerUserId)).hold;
      } catch {
        approvalHold = true;
      }
      let reply = "";
      let violations: string[] = [];
      try {
        let serviceWorkspace = false;
        try {
          serviceWorkspace = (await loadServiceWorkspaceIds(db)).includes(workspaceId);
        } catch {
          serviceWorkspace = false;
        }
        // The policy site is the permissive one (link + the PropLane line); `composePlatformReply` then removes whatever THIS site forbids.
        const turn = await runLeasingEmailAgentTurn(db, {
          landlordId: managerUserId,
          prospectEmail: `l-${handle}@${lead.site}.guest.invalid`,
          inboundText: lead.body,
          inboundEmailId: parsed.emailId,
          channel: { site: "spareroom", siteLabel: PLATFORM_LEAD_LABEL[lead.site], guestName: lead.senderName, listingLine: [`${PLATFORM_LEAD_LABEL[lead.site]} inquiry`, listingLine].filter(Boolean).join(": ") || null, holdReason, serviceWorkspace, proplaneLine: textNumberDisplay },
        });
        reply = turn?.reply?.trim() ?? "";
        violations = turn?.channel?.violations ?? [];
      } catch (cause) {
        await finishEmailAutoReplyCredit(db, { managerUserId, key: credit.key, replyProduced: false });
        throw cause;
      }
      await finishEmailAutoReplyCredit(db, { managerUserId, key: credit.key, replyProduced: Boolean(reply) });
      return { reply, violations, approvalHold, produced: Boolean(reply) };
    },
    sendRelay: async ({ to, subject, text, from }) => {
      const sent = await deliverManagerEmailReply({ managerUserId, toEmail: to, subject, text, fromAddress: from, replyTo: from });
      return sent.ok;
    },
    stampThread: async (threadId, patch) => {
      await stampThreadRowData(db, threadId, patch).catch(() => false);
    },
    rateOk: async (key, limit, windowMs) => (await rateLimit(key, limit, windowMs)).ok,
    storeUnanswered: (why) => storeChannelMailUnanswered(db, base, why),
    notify: async (text, key, propertyId) => {
      const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
      await notifyManagerFromAgent(db, { landlordId: managerUserId, subject: "Platform inquiry", text, category: "messages", notify: { push: true, sms: false }, idempotencyKey: key, propertyId, workspaceId }).catch(() => undefined);
    },
  };

  return ingestPlatformLead(deps, {
    emailId: parsed.emailId,
    messageIdHeader: normalizeInboundHeaders(headers)["message-id"]?.[0]?.trim() ?? null,
    site,
    fromEmail: parsed.fromEmail,
    fromName: parsed.fromName ?? null,
    subject: parsed.subject,
    rawBody: input.rawBody,
    replyTo,
    receivedAt: parsed.receivedAt ?? new Date().toISOString(),
    workspaceId,
    ownerUserId: managerUserId,
    mailbox: input.mailbox,
    authenticated,
  });
}
