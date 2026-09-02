import { NextResponse } from "next/server";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createTourInquiry, textValue } from "@/lib/tour-inquiry-create.server";
import { linkTourInquiryToResident } from "@/lib/tour-resident-link.server";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Each creation failure has one right status; never collapse them to 500. */
const STATUS_BY_REASON: Record<string, number> = {
  invalid_contact: 400,
  missing_host: 400,
  slot_unavailable: 403,
  conflict: 409,
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
    if (!rateLimit(`partner-inquiries:${clientIpFrom(req)}`, 30, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as { row?: unknown };
    if (!isObject(body.row)) {
      return NextResponse.json({ error: "row required" }, { status: 400 });
    }

    const incoming = { ...(body.row as Record<string, unknown>) };

    let linkingUserId: string | null = null;
    let linkingEmail: string | null = null;
    try {
      const ctx = await getPortalAccessContext();
      if (ctx.user) {
        const accountEmail = normalizeEmail(ctx.profile?.email ?? ctx.user.email);
        if (accountEmail.includes("@")) {
          if (textValue(incoming.kind) === "tour") {
            incoming.email = accountEmail;
          }
          linkingUserId = ctx.user.id;
          linkingEmail = accountEmail;
        }
      }
    } catch {
      /* optional session — public route still accepts anonymous tour requests */
    }

    const db = createSupabaseServiceRoleClient();
    const created = await createTourInquiry(db, { incoming });
    if (!created.ok) {
      return NextResponse.json(
        { error: created.error },
        { status: STATUS_BY_REASON[created.reason] ?? 500 },
      );
    }

    if (linkingUserId && linkingEmail && textValue(created.row.kind) === "tour") {
      try {
        await ensureSignedInResidentAccount(db, { id: linkingUserId, email: linkingEmail });
        await linkTourInquiryToResident(db, {
          userId: linkingUserId,
          inquiryId: created.inquiryId,
          email: linkingEmail,
        });
      } catch {
        // A link failure must not fail the booking — backfill runs on portal load.
      }
    }

    return NextResponse.json({ ok: true, row: created.row });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save inquiry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
