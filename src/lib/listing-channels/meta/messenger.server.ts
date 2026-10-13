import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { loadSyncListing, resolveListingPostContact } from "@/lib/listing-channels/sync.server";
import { taggedListingLink } from "@/lib/listing-channels/post-text";
import { metaAppLive } from "@/lib/listing-channels/registry";
import { loadMetaConnectionByPageId, markMetaConnectionRevoked, type MetaConnection } from "@/lib/listing-channels/meta/connection.server";
import { MetaGraphError, sendMetaPageMessage } from "@/lib/listing-channels/meta/graph.server";
import { PORTAL_UNDELIVERABLE_EMAIL_SUFFIXES } from "@/lib/portal-sandbox-accounts";

const FACEBOOK_LEAD_EMAIL_SUFFIX = PORTAL_UNDELIVERABLE_EMAIL_SUFFIXES[0];

export const MESSENGER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Constant-time check of `X-Hub-Signature-256` over the RAW body. Fails closed when the secret is unset. */
export function verifyMetaWebhookSignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  const key = secret?.trim();
  if (!key || !header) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", key).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type MessengerInbound = {
  pageId: string;
  senderPsid: string;
  text: string;
  mid: string;
  ref: string | null;
};

type RawEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; referral?: { ref?: string } };
  referral?: { ref?: string };
  postback?: { payload?: string; referral?: { ref?: string } };
};

/** Text messages from a person to the Page. Echoes, receipts, deliveries, postbacks and the Page's own sends are dropped. */
export function extractMessengerInbound(payload: unknown): MessengerInbound[] {
  const body = payload as { object?: string; entry?: { id?: string; messaging?: RawEvent[] }[] } | null;
  if (!body || body.object !== "page" || !Array.isArray(body.entry)) return [];
  const out: MessengerInbound[] = [];
  for (const entry of body.entry) {
    for (const ev of entry.messaging ?? []) {
      const pageId = String(ev.recipient?.id ?? entry.id ?? "").trim();
      const senderPsid = String(ev.sender?.id ?? "").trim();
      const text = typeof ev.message?.text === "string" ? ev.message.text.trim() : "";
      if (!pageId || !senderPsid || !text) continue;
      if (ev.message?.is_echo || senderPsid === pageId) continue;
      const ref = ev.referral?.ref ?? ev.message?.referral?.ref ?? null;
      out.push({ pageId, senderPsid, text, mid: String(ev.message?.mid ?? "").trim(), ref: ref ? String(ref) : null });
    }
  }
  return out;
}

export type ReplyListing = { propertyId: string; title: string; url: string };

async function resolveReplyListing(db: SupabaseClient, conn: MetaConnection, ref: string | null): Promise<ReplyListing | null> {
  const origin = resolveEmailLinkBaseUrl();
  const toReply = (l: NonNullable<Awaited<ReturnType<typeof loadSyncListing>>>): ReplyListing => ({
    propertyId: l.propertyId,
    title: (l.projected.title || l.projected.buildingName || "").trim(),
    url: taggedListingLink(buildManagerListingUrl(origin, l.propertyId), "facebook_page"),
  });
  // The ref is only a lead: it counts when it is a live listing of THIS workspace.
  if (ref) {
    const listing = await loadSyncListing(db, ref).catch(() => null);
    if (listing && listing.live && listing.workspaceId === conn.workspaceId) return toReply(listing);
  }
  const { data } = await db
    .from("manager_property_records")
    .select("id")
    .eq("workspace_id", conn.workspaceId)
    .eq("status", "live")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.id) return null;
  const listing = await loadSyncListing(db, String(data.id)).catch(() => null);
  return listing ? toReply(listing) : null;
}

export function buildMessengerReplyText(args: { listingTitle: string | null; phone: string; email: string | null; listingUrl: string | null }): string {
  const pretty = formatSmsPhoneLabel(args.phone) ?? args.phone;
  const about = args.listingTitle ? ` about ${args.listingTitle}` : "";
  const contact = args.email ? `text ${pretty} or email ${args.email}` : `text ${pretty}`;
  const parts = [`Thanks for asking${about}! Fastest way to see it: ${contact}.`];
  if (args.listingUrl) parts.push(`Details and photos: ${args.listingUrl}.`);
  parts.push("This inbox isn't watched.");
  return parts.join(" ");
}

/** The thread key for a Messenger sender. `shouldSkipOutboundEmail` refuses this domain, so no reply is ever mailed to it. */
function syntheticEmail(psid: string): string {
  return `facebook-${psid.replace(/[^A-Za-z0-9_-]/g, "")}${FACEBOOK_LEAD_EMAIL_SUFFIX}`;
}

async function appendLead(
  db: SupabaseClient,
  conn: MetaConnection,
  args: { psid: string; text: string; mid: string; outbound: boolean; listing: ReplyListing | null; now: Date; messageId: string },
) {
  const email = syntheticEmail(args.psid);
  const subject = args.listing?.title ? `Facebook · ${args.listing.title}` : "Facebook message";
  return deliverPortalMessageThreadSide(db, {
    scope: scopeForRole("manager"),
    folder: "inbox",
    ownerUserId: conn.managerUserId,
    participantEmail: email,
    otherPartyEmail: email,
    conversation: { managerUserId: conn.managerUserId, workspaceId: conn.workspaceId },
    fallbackId: `facebook-lead:${conn.workspaceId}:${args.psid}`,
    fromName: args.outbound ? "PropLane" : "Facebook visitor",
    subject,
    body: args.text,
    preview: args.text.slice(0, 100).replace(/\n/g, " "),
    when: formatPacificDateTime(args.now),
    unread: !args.outbound,
    outbound: args.outbound,
    automated: args.outbound,
    messageId: args.messageId,
    channel: "facebook",
    messageSubject: subject,
    ...(args.listing ? { recordRef: { kind: "property", id: args.listing.propertyId, label: args.listing.title || "Listing" } } : {}),
  });
}

export type MessengerDeps = {
  now?: Date;
  loadConnection?: typeof loadMetaConnectionByPageId;
  send?: typeof sendMetaPageMessage;
  live?: () => boolean;
};

export type MessengerOutcome = "ignored" | "lead_only" | "replied" | "already_replied" | "failed";

/** One inbound Page text: authorize (Page → workspace), append the lead, reply once per sender per 24h. */
export async function handleMessengerInbound(db: SupabaseClient, inbound: MessengerInbound, deps: MessengerDeps = {}): Promise<MessengerOutcome> {
  const now = deps.now ?? new Date();
  if (!(deps.live ?? metaAppLive)()) {
    console.info("meta messenger: app not live, ignoring");
    return "ignored";
  }
  const conn = await (deps.loadConnection ?? loadMetaConnectionByPageId)(db, inbound.pageId).catch(() => null);
  if (!conn || !conn.pageId) {
    console.info("meta messenger: no Page connection, ignoring");
    return "ignored";
  }

  const listing = await resolveReplyListing(db, conn, inbound.ref).catch(() => null);
  // The lead is filed once (the message id dedupes a redelivered webhook).
  const midKey = inbound.mid || `${inbound.senderPsid}:${now.getTime()}`;
  await appendLead(db, conn, { psid: inbound.senderPsid, text: inbound.text, mid: inbound.mid, outbound: false, listing, now, messageId: `facebook-in:${midKey}` });

  const contact = await resolveListingPostContact(db, conn.managerUserId, conn.workspaceId);
  if (!contact.phone?.trim()) {
    console.info("meta messenger: workspace has no work number, no reply sent");
    return "lead_only";
  }

  // Claim the (Page, sender) slot for 24h in ONE conditional upsert (SQL function); a concurrent delivery gets no row back.
  const { data: claimed, error: claimError } = await db.rpc("claim_meta_messenger_reply", {
    p_page_id: inbound.pageId,
    p_sender_psid: inbound.senderPsid,
    p_listing_id: listing?.propertyId ?? null,
    p_manager_user_id: conn.managerUserId,
    p_workspace_id: conn.workspaceId,
    p_now: now.toISOString(),
  });
  if (claimError) {
    console.warn("meta messenger: could not record reply claim", claimError.message);
    return "failed";
  }
  if (!Array.isArray(claimed) || claimed.length === 0) return "already_replied";

  const text = buildMessengerReplyText({ listingTitle: listing?.title || null, phone: contact.phone, email: contact.email?.trim() || null, listingUrl: listing?.url ?? null });
  try {
    await (deps.send ?? sendMetaPageMessage)({ pageId: inbound.pageId, token: conn.pageToken, recipientPsid: inbound.senderPsid, text });
  } catch (error) {
    // Release the claim so the next message can try again; a rejected token stops until reconnect.
    await db.from("meta_messenger_replies").delete().eq("page_id", inbound.pageId).eq("sender_psid", inbound.senderPsid);
    if (error instanceof MetaGraphError && error.needsReconnect) await markMetaConnectionRevoked(db, conn.workspaceId).catch(() => undefined);
    console.warn("meta messenger: reply failed", error instanceof Error ? error.message : error);
    return "failed";
  }
  await appendLead(db, conn, { psid: inbound.senderPsid, text, mid: "", outbound: true, listing, now, messageId: `facebook-out:${midKey}` });
  return "replied";
}
