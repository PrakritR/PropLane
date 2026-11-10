import { NextResponse } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";
import { readListingSource } from "@/lib/listing-channels/lead-source.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createTourInquiry, textValue } from "@/lib/tour-inquiry-create.server";
import { linkTourInquiryToResident } from "@/lib/tour-resident-link.server";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Each creation failure has one right status; never collapse them to 500. */
const STATUS_BY_REASON: Record<string, number> = {
  invalid_contact: 400,
  missing_host: 400,
  slot_unavailable: 403,
  application_required: 403,
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
      /* Optional session: `kind: "partner"` is still anonymous. A tour is not — an unreadable
         session leaves `linkingUser` null and the refusal below fails closed. */
    }

    // A tour needs a signed-in account, slot-mode and requested-time alike (captain, Nov 3: no anonymous
    // booking). Checked HERE, before anything is read or written, and it fails closed: an unreadable
    // session is an anonymous one. A body's `email` proves nothing. The assistant's tour tools and the
    // leasing SMS agent call `createTourInquiry` directly, never this route, so they are unaffected. The
    // one anonymous use left is `kind: "partner"` (the partner-meeting scheduler), which books no tour.
    if (textValue(incoming.kind) === "tour" && !linkingUser) {
      return NextResponse.json({ error: "Sign in to request a tour.", reason: "sign_in_required" }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    // Only the session's own email counts toward "Application before a tour"; the body's does not.
    const created = await createTourInquiry(db, {
      incoming,
      verifiedApplicantEmail: linkingEmail,
      verifiedApplicantUserId: linkingUser?.id ?? null,
      sourceChannel: textValue(incoming.kind) === "tour" ? await readListingSource(req) : null,
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

    return NextResponse.json({ ok: true, row: created.row });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save inquiry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
