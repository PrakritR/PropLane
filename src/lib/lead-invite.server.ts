/**
 * Shared lead-invite core: server-side share authorization, invite-link
 * building, and the Resend email with mailto fallback. Extracted from
 * `/api/portal/send-lead-invite` so the manager UI route and the agent's
 * share_property_link tool run the exact same pipeline (one implementation,
 * not two).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { track } from "@/lib/analytics/posthog";
import { recordResidentProspectInboxMessage } from "@/lib/tour-notification-delivery.server";
import {
  buildLeadInviteEmailBody,
  buildLeadInviteEmailHtml,
  buildLeadInviteMailtoHref,
  leadInviteSubject,
  type LeadInviteKind,
} from "@/lib/lead-invite-email";
import {
  buildManagerApplyUrl,
  buildManagerListingUrl,
  buildManagerTourUrl,
} from "@/lib/manager-property-links";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { getShareablePropertyForUser } from "@/lib/manager-property-share-access";
import { postResendEmail } from "@/lib/resend-delivery.server";
import {
  fromHeaderAddress,
  fromHeaderDisplayName,
  managerOutboundFromHeader,
} from "@/lib/manager-outbound-identity.server";

export type { LeadInviteKind };

/** Roles allowed to send prospect invites (matches the original route gate). */
export function canSendLeadInvite(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

/** True when outbound invite email can actually be delivered (Resend configured). */
export function leadInviteEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** App origin for invite links — same canonical base as outbound emails. */
export function leadInviteAppOrigin(_requestOrigin?: string | null): string {
  return resolveEmailLinkBaseUrl();
}

/** The link a given invite kind sends the prospect to (apply/listing → apply URL, tour → tour URL). */
export function buildLeadInviteLinkUrl(
  origin: string,
  kind: LeadInviteKind,
  propertyId: string,
  opts?: { listingRoomId?: string; roomName?: string },
): string {
  if (kind === "tour") return buildManagerTourUrl(origin, propertyId);
  return buildManagerApplyUrl(origin, {
    propertyId,
    listingRoomId: opts?.listingRoomId || undefined,
    roomName: opts?.roomName || undefined,
  });
}

export type SendLeadInviteInput = {
  kind: LeadInviteKind;
  /** Normalized (trimmed, lowercased) recipient email — format-validated by the caller. */
  to: string;
  prospectName?: string;
  propertyId: string;
  listingRoomId?: string;
  roomName?: string;
  note?: string;
  /** Absolute app origin used to build the invite links (see leadInviteAppOrigin). */
  origin: string;
};

export type SendLeadInviteResult =
  | { ok: true; emailId: string | null; linkUrl: string; propertyTitle: string }
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 502 | 503; error: string; mailtoHref: string; linkUrl: string; propertyTitle: string };

/**
 * Authorize + build + send a prospect invite for one of the actor's properties.
 * Ownership is enforced server-side via getShareablePropertyForUser (owner,
 * assigned co-manager, or platform admin; live listings only) — the
 * client-supplied propertyId is never trusted. When Resend is not configured,
 * returns a mailto fallback instead of sending.
 */
export async function sendLeadInvite(
  db: SupabaseClient,
  actor: { userId: string },
  input: SendLeadInviteInput,
): Promise<SendLeadInviteResult> {
  const { data: requestor, error: requestorError } = await db
    .from("profiles")
    .select("role")
    .eq("id", actor.userId)
    .maybeSingle();
  if (requestorError || !requestor) {
    return { ok: false, status: 403, error: requestorError?.message ?? "Profile not found." };
  }
  if (!canSendLeadInvite(requestor.role)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  // Server-side authorization: the manager may only share a property they own
  // (or are assigned as co-manager), verified against the Supabase source of
  // truth — never trust the client-supplied propertyId. Also yields the live
  // listing used to build the invite below.
  const listing = await getShareablePropertyForUser(actor.userId, input.propertyId);
  if (!listing) {
    return { ok: false, status: 403, error: "You cannot share links for this property." };
  }

  const propertyTitle = (listing.title || listing.buildingName || listing.address || input.propertyId).trim();
  const linkUrl = buildLeadInviteLinkUrl(input.origin, input.kind, input.propertyId, {
    listingRoomId: input.listingRoomId,
    roomName: input.roomName,
  });
  const tourUrl = buildManagerTourUrl(input.origin, input.propertyId);
  const listingPageUrl = buildManagerListingUrl(input.origin, input.propertyId);
  const listingSummary =
    input.kind === "listing"
      ? buildListingShareSummary(listing, {
          roomChoice: input.roomName || undefined,
          roomId: input.listingRoomId || undefined,
        })
      : undefined;

  const emailParams = {
    kind: input.kind,
    prospectName: input.prospectName?.trim() || undefined,
    propertyTitle,
    linkUrl,
    listingPageUrl: input.kind === "listing" ? listingPageUrl : undefined,
    tourUrl: input.kind === "listing" ? tourUrl : undefined,
    listingSummary,
    managerNote: input.note?.trim() || undefined,
  };
  const subject = leadInviteSubject(input.kind, propertyTitle);
  const text = buildLeadInviteEmailBody(emailParams);
  const html = buildLeadInviteEmailHtml(emailParams);
  const mailtoHref = buildLeadInviteMailtoHref({ to: input.to, ...emailParams });

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Email delivery is not configured (set RESEND_API_KEY).",
      mailtoHref,
      linkUrl,
      propertyTitle,
    };
  }

  const from = await managerOutboundFromHeader(db, actor.userId);
  const res = await postResendEmail({
    apiKey,
    actorUserId: actor.userId,
    payload: { from, to: [input.to], subject, text, html },
    effectSummary: `${input.kind} invite email to ${input.prospectName?.trim() || input.to} was captured for SMS test mode.`,
    metadata: { tool: "share_property_link", propertyId: input.propertyId, kind: input.kind },
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      error: payload.message ?? res.statusText,
      mailtoHref,
      linkUrl,
      propertyTitle,
    };
  }

  await recordResidentProspectInboxMessage(db, {
    participantEmail: input.to,
    subject,
    body: text,
    fromName: fromHeaderDisplayName(from),
    fromEmail: fromHeaderAddress(from),
  });

  track("lead_invite_sent", actor.userId, { kind: input.kind, property_id: input.propertyId });
  return { ok: true, emailId: payload.id ?? null, linkUrl, propertyTitle };
}
