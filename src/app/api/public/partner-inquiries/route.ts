import { NextResponse } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";
import { readListingSource } from "@/lib/listing-channels/lead-source.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { phoneRateKey } from "@/lib/sms/phone-key";
import { normalizeTourContactPhone } from "@/lib/tour-contact-quality";
import { loadGuestTourListing, recordGuestTourProspect } from "@/lib/tour-guest-prospect.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createTourInquiry, textValue } from "@/lib/tour-inquiry-create.server";
import { linkTourInquiryToResident } from "@/lib/tour-resident-link.server";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;
/** A guest tour has no account behind it: the caps are on the two things one person cannot cheaply multiply. */
export const GUEST_TOURS_PER_IP_PER_HOUR = 6;
export const GUEST_TOURS_PER_PHONE_PER_HOUR = 3;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Each creation failure has one right status; never collapse them to 500. */
const STATUS_BY_REASON: Record<string, number> = {
  invalid_contact: 400,
  missing_host: 400,
  slot_unavailable: 403,
  sign_in_required: 401,
  identity_required: 403,
  identity_unavailable: 503,
  conflict: 409,
  duplicate_request: 409,
  rate_limited: 429,
  write_failed: 500,
};

/**
 * Public tour / partner-meeting request intake.
 *
 * The creation itself — contact validation, the host + published-slot guards,
 * the double-book check, the write, consent, and notifications — lives in
 * `createTourInquiry` so the assistant's tour tools file an inquiry through the
 * exact same path. What stays here is what only an HTTP request has: rate
 * limiting, the optional signed-in session used to link the inquiry to a
 * resident account, and the result-to-status mapping.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`partner-inquiries:${clientIpFrom(req)}`, 30, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as { row?: unknown };
    if (!isObject(body.row)) {
      return NextResponse.json({ error: "row required" }, { status: 400 });
    }

    const incoming = { ...(body.row as Record<string, unknown>) };
    // Anonymous input never names the row it writes. `createTourInquiry` mints the id too;
    // dropping it here keeps the public boundary readable about what is server-owned.
    delete incoming.id;

    let linkingUser: { id: string; email?: string | null; email_confirmed_at?: string | null } | null = null;
    let linkingEmail: string | null = null;
    try {
      const ctx = await getPortalAccessContext();
      if (ctx.user) {
        const accountEmail = verifiedSessionEmail(ctx.user, ctx.profile?.email);
        if (accountEmail.includes("@")) {
          if (textValue(incoming.kind) === "tour") {
            incoming.email = accountEmail;
          }
          linkingUser = ctx.user;
          linkingEmail = accountEmail;
        }
      }
    } catch {
      /* Optional session: an unreadable one is an anonymous one. A tour is then a guest tour (below), which
         re-derives everything instead of trusting the body. */
    }

    const isTour = textValue(incoming.kind) === "tour";
    // A tour is never given its own status, host list or fee stamp by a public caller: those are server-owned.
    if (isTour) {
      delete incoming.status;
    }

    const db = createSupabaseServiceRoleClient();

    // A tour needs NO account (captain, Nov 14: a renter from Facebook, Zillow or Roomies books a tour and applies without
    // one; this replaces the Nov 3 sign-in wall). A guest is whoever has no readable session, and a body's `email` proves
    // nothing, so everything that decides access is re-derived here: the home (a LIVE listing, never the body's word for
    // its owner), the host and the published slot (`createTourInquiry`), and the contact fields. A guest is bounded per IP
    // and per phone, the two things one person cannot cheaply multiply.
    const guest = isTour && !linkingUser;
    let guestListing: Awaited<ReturnType<typeof loadGuestTourListing>> = null;
    if (guest) {
      const phone = normalizeTourContactPhone(textValue(incoming.phone));
      if (!phone) return NextResponse.json({ error: "Phone number must be 10 digits.", reason: "invalid_contact" }, { status: 400 });
      const ip = clientIpFrom(req);
      if (!(await rateLimit(`guest-tour-ip:${ip}`, GUEST_TOURS_PER_IP_PER_HOUR, HOUR_MS)).ok) {
        return NextResponse.json({ error: "Too many tour requests. Please try again later.", reason: "rate_limited" }, { status: 429 });
      }
      if (!(await rateLimit(`guest-tour-phone:${phoneRateKey(phone)}`, GUEST_TOURS_PER_PHONE_PER_HOUR, HOUR_MS)).ok) {
        return NextResponse.json({ error: "Too many tour requests for this number. Please try again later.", reason: "rate_limited" }, { status: 429 });
      }
      guestListing = await loadGuestTourListing(db, textValue(incoming.propertyId));
      if (!guestListing) return NextResponse.json({ error: "This listing is not available.", reason: "slot_unavailable" }, { status: 404 });
      // Re-stamp the home from the database; the body's title is display text only and is capped.
      incoming.propertyId = guestListing.propertyId;
      incoming.propertyTitle = textValue(incoming.propertyTitle).slice(0, 200) || guestListing.propertyLabel;
    }

    // Only the session's own email is the verified applicant; the body's is not.
    const created = await createTourInquiry(db, {
      incoming,
      verifiedApplicantEmail: linkingEmail,
      verifiedApplicantUserId: linkingUser?.id ?? null,
      sourceChannel: isTour ? await readListingSource(req) : null,
      // A guest is answered by email and a text (when they ticked the box), never by a /resident link they cannot open.
      ...(guest ? { guestApplicant: true, noticeChannel: "sms" as const } : {}),
      beforeTourNotifications: linkingUser && linkingEmail ? async ({ inquiryId }) => {
        const ensured = await ensureSignedInResidentAccount(db, linkingUser);
        if (!ensured.ok) return;
        await linkTourInquiryToResident(db, { userId: linkingUser.id, inquiryId, email: linkingEmail });
      } : undefined,
    });
    if (!created.ok) {
      return NextResponse.json(
        { error: created.error, ...(created.reason === "identity_required" ? { blocked: "identity", href: "/resident/profile?tab=profile#verification" } : {}) },
        { status: STATUS_BY_REASON[created.reason] ?? 500 },
      );
    }

    if (guest && guestListing) {
      // The prospect spine: one thread per person per workspace, tagged with the house. Best-effort: the request is
      // already filed and the manager already has it on their calendar.
      const firstWindow = Array.isArray(created.row.requestedWindows) ? (created.row.requestedWindows as Array<Record<string, unknown>>)[0] : null;
      await recordGuestTourProspect(db, {
        listing: guestListing,
        inquiryId: created.inquiryId,
        name: textValue(created.row.name),
        phone: textValue(created.row.phone),
        roomLabel: textValue(created.row.roomLabel).slice(0, 120),
        whenLabel: typeof firstWindow?.start === "string" ? firstWindow.start : "",
      }).catch(() => false);
    }

    return NextResponse.json({ ok: true, row: created.row });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save inquiry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
