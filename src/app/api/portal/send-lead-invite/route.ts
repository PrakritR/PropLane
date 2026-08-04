import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import {
  buildLeadInviteEmailBody,
  buildLeadInviteEmailHtml,
  buildLeadInviteMailtoHref,
  buildLeadInviteSmsText,
  leadInviteSubject,
} from "@/lib/lead-invite-email";
import {
  buildManagerApplyUrl,
  buildManagerBrowseUrl,
  buildManagerListingUrl,
  buildManagerPortfolioApplyUrl,
  buildManagerPortfolioTourUrl,
  buildManagerTourUrl,
} from "@/lib/manager-property-links";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { unloggedSmsWarning } from "@/lib/manager-sms-messages";
import { getShareablePropertyForUser } from "@/lib/manager-property-share-access";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { recordResidentProspectInboxMessage } from "@/lib/tour-notification-delivery.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { normalizeE164 } from "@/lib/twilio";
import { resolveManagerWorkNumber } from "@/lib/twilio-provisioning";

export const runtime = "nodejs";

// Domain is matched as dot-separated labels (no char class overlaps the "." delimiter)
// so there is exactly one way to parse a match — avoids polynomial backtracking on
// attacker-controlled input.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Each requested id costs one Supabase authorization lookup, so bound the
// fan-out to keep a single request from triggering unbounded parallel queries.
const MAX_PROPERTY_IDS = 100;

function canSendLeadInvite(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

// Emails link to the canonical domain only — never a *.vercel.app deploy URL.
function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    let body: {
      kind?: unknown;
      to?: unknown;
      phone?: unknown;
      viaEmail?: unknown;
      viaSms?: unknown;
      prospectName?: unknown;
      propertyId?: unknown;
      propertyIds?: unknown;
      listingRoomId?: unknown;
      roomName?: unknown;
      note?: unknown;
      rentalType?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const kind =
      body.kind === "tour" ? "tour" : body.kind === "listing" ? "listing" : body.kind === "apply" ? "apply" : null;
    const viaSms = body.viaSms === true;
    const viaEmail = body.viaEmail !== false;
    const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
    // An unparseable number normalizes to "" so it fails the `viaSms` guard below like a blank one.
    const phone = (phoneRaw ? normalizeE164(phoneRaw) : "") ?? "";
    const prospectName = typeof body.prospectName === "string" ? body.prospectName.trim() : "";
    const singlePropertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const listingRoomId = typeof body.listingRoomId === "string" ? body.listingRoomId.trim() : "";
    const roomName = typeof body.roomName === "string" ? body.roomName.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const rentalType = body.rentalType === "short_term" ? "short_term" : "standard";

    if (!kind) return NextResponse.json({ error: "kind must be apply, tour, or listing." }, { status: 400 });
    if (!viaEmail && !viaSms) {
      return NextResponse.json({ error: "Choose email, SMS, or both." }, { status: 400 });
    }
    if (viaEmail && (!to || !EMAIL_RE.test(to))) {
      return NextResponse.json({ error: "A valid recipient email is required." }, { status: 400 });
    }
    if (viaSms && !phone) {
      return NextResponse.json({ error: "A valid US phone number is required for SMS." }, { status: 400 });
    }

    // Listing, apply, and tour sends may include several properties at once.
    // Normalize both shapes (array or legacy scalar) into a deduped id list; the
    // room selector only applies to a single-property apply send.
    const rawIds = Array.isArray(body.propertyIds)
      ? body.propertyIds.filter((v): v is string => typeof v === "string")
      : [];
    const requestedIds: string[] = [];
    const seenIds = new Set<string>();
    for (const raw of [...rawIds, singlePropertyId]) {
      const id = raw.trim();
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        requestedIds.push(id);
      }
    }
    if (requestedIds.length === 0) {
      return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    }
    if (requestedIds.length > MAX_PROPERTY_IDS) {
      return NextResponse.json(
        { error: `You can share at most ${MAX_PROPERTY_IDS} properties in one send.` },
        { status: 400 },
      );
    }
    const effectiveIds = requestedIds;

    const svc = createSupabaseServiceRoleClient();
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (requestorError || !requestor) {
      return NextResponse.json({ error: requestorError?.message ?? "Profile not found." }, { status: 403 });
    }
    if (!canSendLeadInvite(requestor.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    // Server-side authorization: the manager may only share properties they own
    // (or are assigned as co-manager), verified against the Supabase source of
    // truth — never trust the client-supplied ids. Also yields the live listings
    // used to build the invite below. Every requested id must be authorized.
    const listings = await Promise.all(
      effectiveIds.map(async (id) => ({ id, listing: await getShareablePropertyForUser(user.id, id) })),
    );
    const authorized = listings.filter((entry): entry is { id: string; listing: NonNullable<typeof entry.listing> } =>
      Boolean(entry.listing),
    );
    if (authorized.length !== effectiveIds.length || authorized.length === 0) {
      return NextResponse.json({ error: "You cannot share links for one or more of these properties." }, { status: 403 });
    }

    if (kind === "apply" && rentalType === "short_term") {
      const shortTermBlocked = authorized.some(
        (entry) => !entry.listing?.listingSubmission?.shortTermRentalsAllowed,
      );
      if (shortTermBlocked) {
        return NextResponse.json(
          { error: "Short-term applications are not enabled for one or more selected properties." },
          { status: 400 },
        );
      }
    }

    const isMultiListing = kind === "listing" && authorized.length > 1;
    const isMultiApply = kind === "apply" && authorized.length > 1;
    const isPortfolioTour = kind === "tour" && authorized.length > 1;
    const primary = authorized[0];
    const propertyId = primary.id;
    const listing = primary.listing;
    const origin = appOrigin();

    const propertyTitle = isMultiListing || isMultiApply
      ? `${authorized.length} homes`
      : isPortfolioTour
        ? `${authorized.length} properties`
        : (listing?.title || listing?.buildingName || listing?.address || propertyId).trim();
    const applyUrl = buildManagerApplyUrl(origin, {
      propertyId,
      listingRoomId: listingRoomId || undefined,
      roomName: roomName || undefined,
      rentalType: rentalType === "short_term" ? "short_term" : undefined,
    });
    const tourUrl = buildManagerTourUrl(origin, propertyId);
    const listingPageUrl = buildManagerListingUrl(origin, propertyId);
    const listingCount = isMultiListing || isMultiApply ? authorized.length : undefined;
    const tourCount = isPortfolioTour ? authorized.length : undefined;
    const authorizedIds = authorized.map((entry) => entry.id);
    const linkUrl = isMultiListing
      ? buildManagerBrowseUrl(origin, authorizedIds)
      : isMultiApply
        ? buildManagerPortfolioApplyUrl(origin, authorizedIds, {
            rentalType: rentalType === "short_term" ? "short_term" : undefined,
          })
        : isPortfolioTour
        ? buildManagerPortfolioTourUrl(origin, authorizedIds)
        : kind === "tour"
          ? tourUrl
          : applyUrl;
    const listingSummary =
      kind === "listing" && !isMultiListing && listing
        ? buildListingShareSummary(listing, { roomChoice: roomName || undefined, roomId: listingRoomId || undefined })
        : undefined;

    const subject = leadInviteSubject(kind, propertyTitle, listingCount ?? tourCount);
    const emailParams = {
      kind,
      prospectName: prospectName || undefined,
      propertyTitle,
      linkUrl,
      listingPageUrl: kind === "listing" && !isMultiListing ? listingPageUrl : undefined,
      tourUrl: kind === "listing" && !isMultiListing ? tourUrl : undefined,
      listingSummary,
      managerNote: note || undefined,
      listingCount,
      tourCount,
    } satisfies Parameters<typeof buildLeadInviteEmailBody>[0];
    const text = buildLeadInviteEmailBody(emailParams);
    const html = buildLeadInviteEmailHtml(emailParams);
    const mailtoHref = viaEmail ? buildLeadInviteMailtoHref({ to, ...emailParams }) : "";
    const smsText = buildLeadInviteSmsText({
      kind,
      prospectName: prospectName || undefined,
      propertyTitle,
      linkUrl,
      listingCount,
      tourCount,
      managerNote: note || undefined,
    });

    let emailId: string | null = null;
    let smsLogWarning: string | null = null;
    if (viaEmail) {
      const apiKey = process.env.RESEND_API_KEY?.trim();
      if (!apiKey) {
        return NextResponse.json(
          { ok: false, error: "Email delivery is not configured (set RESEND_API_KEY).", mailtoHref },
          { status: 503 },
        );
      }

      const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: payload.message ?? res.statusText, mailtoHref }, { status: 502 });
      }
      emailId = payload.id ?? null;

      await recordResidentProspectInboxMessage(svc, {
        participantEmail: to,
        subject,
        body: text,
        fromName: "PropLane",
        fromEmail: "invites@axis.local",
      });
    }

    if (viaSms) {
      const workNumber = await resolveManagerWorkNumber(svc, user.id);
      if (!workNumber) {
        return NextResponse.json(
          {
            ok: false,
            error: "No work number on this account yet. Open View number or finish SMS setup first.",
            emailSent: viaEmail && Boolean(emailId),
          },
          { status: 400 },
        );
      }
      const smsResult = await sendFromManagerWorkNumber({
        managerUserId: user.id,
        to: phone,
        text: smsText,
        fromNumber: workNumber,
        source: "lead_invite",
        counterpartyRole: "prospect",
      });
      if (!smsResult.ok) {
        return NextResponse.json(
          {
            ok: false,
            error:
              smsResult.error === "recipient_opted_out"
                ? "That number has opted out of texts."
                : "Could not send SMS.",
            emailSent: viaEmail && Boolean(emailId),
          },
          { status: 502 },
        );
      }
      if (smsResult.logged === false) {
        // The text is already gone, so failing the request would only invite a
        // duplicate send. Say it out loud instead of swallowing it: the most
        // likely cause is `…_manager_sms_lead_invite_source.sql` not yet
        // applied, which makes every share vanish from Communication → SMS.
        console.error("send-lead-invite: SMS sent but manager_sms_messages row did not land", {
          managerUserId: user.id,
          source: "lead_invite",
        });
        smsLogWarning = unloggedSmsWarning("lead_invite");
      }
    }

    track("lead_invite_sent", user.id, {
      kind,
      property_id: propertyId,
      property_count: authorized.length,
      via_email: viaEmail,
      via_sms: viaSms,
    });
    return NextResponse.json({
      ok: true,
      id: emailId,
      linkUrl,
      viaEmail,
      viaSms,
      smsLogged: viaSms ? !smsLogWarning : undefined,
      warning: smsLogWarning ?? undefined,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to send invite." }, { status: 500 });
  }
}
